import { constants } from 'node:fs'
import { createHash } from 'node:crypto'
import { lstat, open, realpath } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'

const fileSchema = z
  .object({
    reference: z.string().refine(isAbsolute),
    canonical: z.string().refine(isAbsolute),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    bytes: z.number().int().nonnegative(),
    mode: z.number().int().nonnegative(),
    allowGroupWrite: z.boolean().default(false),
    executableHardlink: z.boolean().default(false),
  })
  .strict()
const baselineSchema = z
  .object({
    version: z.literal(1),
    files: z.array(fileSchema).min(1).max(1024),
    runningBytesVerified: z.literal(false),
  })
  .strict()
export class RuntimeArtifactError extends Error {
  constructor(readonly code: 'INVALID_ARTIFACT' | 'ARTIFACT_CHANGED' | 'BASELINE_INVALID') {
    super(code)
    this.name = 'RuntimeArtifactError'
  }
}

async function fingerprint(reference: string, allowGroupWrite = false, executableHardlink = false) {
  if (!isAbsolute(reference)) throw new RuntimeArtifactError('INVALID_ARTIFACT')
  if (allowGroupWrite && !/\/opencode\.jsonc?$/.test(reference)) throw new RuntimeArtifactError('INVALID_ARTIFACT')
  const canonical = await realpath(reference)
  if (allowGroupWrite && executableHardlink) throw new RuntimeArtifactError('INVALID_ARTIFACT')
  if (allowGroupWrite && canonical !== reference) throw new RuntimeArtifactError('INVALID_ARTIFACT')
  const file = await open(canonical, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const before = await file.stat()
    if (
      !before.isFile() ||
      before.uid !== process.getuid?.() ||
      before.nlink !== (executableHardlink ? 2 : 1) ||
      (executableHardlink && (before.mode & 0o111) === 0) ||
      (before.mode & (allowGroupWrite ? 0o002 : 0o022)) !== 0 ||
      before.size > 1024 * 1024 * 1024
    )
      throw new RuntimeArtifactError('INVALID_ARTIFACT')
    const digest = createHash('sha256')
    for await (const bytes of file.createReadStream({ autoClose: false })) digest.update(bytes)
    const after = await file.stat()
    const atPath = await lstat(canonical)
    if (
      (await realpath(reference)) !== canonical ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs ||
      atPath.ino !== before.ino ||
      atPath.dev !== before.dev
    )
      throw new RuntimeArtifactError('ARTIFACT_CHANGED')
    return {
      reference,
      canonical,
      sha256: digest.digest('hex'),
      bytes: before.size,
      mode: before.mode & 0o777,
      allowGroupWrite,
      executableHardlink,
    }
  } finally {
    await file.close()
  }
}

export async function captureRuntimeArtifactBaseline(
  paths: readonly string[],
  options: {
    readonly permittedGroupWritableConfigs?: readonly string[]
    readonly permittedExecutableHardlinks?: readonly string[]
  } = {},
) {
  if (paths.length < 1 || paths.length > 1024 || new Set(paths).size !== paths.length)
    throw new RuntimeArtifactError('BASELINE_INVALID')
  if (options.permittedGroupWritableConfigs?.some((path) => !paths.includes(path)))
    throw new RuntimeArtifactError('BASELINE_INVALID')
  const files = []
  if (options.permittedExecutableHardlinks?.some((path) => !paths.includes(path)))
    throw new RuntimeArtifactError('BASELINE_INVALID')
  for (const path of paths)
    files.push(
      await fingerprint(
        path,
        options.permittedGroupWritableConfigs?.includes(path) ?? false,
        options.permittedExecutableHardlinks?.includes(path) ?? false,
      ),
    )
  const baseline = {
    version: 1 as const,
    files,
    runningBytesVerified: false as const,
  }
  await assertRuntimeArtifactsUnchanged(baseline)
  return baseline
}

export async function assertRuntimeArtifactsUnchanged(input: unknown) {
  const parsed = baselineSchema.safeParse(input)
  if (!parsed.success || new Set(parsed.data.files.map((file) => file.reference)).size !== parsed.data.files.length)
    throw new RuntimeArtifactError('BASELINE_INVALID')
  for (const expected of parsed.data.files) {
    const actual = await fingerprint(expected.reference, expected.allowGroupWrite, expected.executableHardlink)
    if (!isDeepStrictEqual(actual, expected)) throw new RuntimeArtifactError('ARTIFACT_CHANGED')
  }
}
