import { lstat, mkdir, readdir, realpath, rename } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import { z } from 'zod'
import { durableTransferRecord } from './claude-transfer-activate'
import { readPrivateTransferFile } from './claude-transfer-stage'
import { syncDatabasePath } from './claude-database-files'
import type { CutoverStep } from './cutover-step-runner'

export class DirectoryCutoverError extends Error {
  constructor() {
    super('OWNED_DIRECTORY_UNVERIFIED')
    this.name = 'DirectoryCutoverError'
  }
}

async function identity(path: string) {
  try {
    const info = await lstat(path)
    if (!info.isDirectory() || (await realpath(path)) !== path || info.uid !== process.getuid?.() || info.mode & 0o002)
      throw new DirectoryCutoverError()
    return `${info.dev}:${info.ino}`
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined
    throw error
  }
}

export function newDirectoryCutoverStep(input: {
  readonly target: string
  readonly stateDirectory: string
  readonly assertQuiescent: () => Promise<void>
}): CutoverStep {
  const recordPath = join(input.stateDirectory, 'directory-owner.json')
  const intentPath = join(input.stateDirectory, 'directory-intent.json')
  const retired = join(input.stateDirectory, 'directory.retired')
  const owner = async () =>
    z
      .object({ target: z.literal(input.target), identity: z.string() })
      .strict()
      .parse(JSON.parse(await readPrivateTransferFile(recordPath)))
  const validate = async () => {
    if (
      !isAbsolute(input.target) ||
      !isAbsolute(input.stateDirectory) ||
      !(await identity(dirname(input.target))) ||
      !(await identity(input.stateDirectory)) ||
      (await lstat(input.stateDirectory)).mode & 0o077
    )
      throw new DirectoryCutoverError()
    await input.assertQuiescent()
  }
  return {
    name: 'create-model-plugin-directory',
    forward: async () => {
      await validate()
      try {
        const saved = await owner()
        if ((await identity(input.target)) !== saved.identity) throw new DirectoryCutoverError()
        return
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
      }
      if (await identity(input.target)) throw new DirectoryCutoverError()
      await durableTransferRecord(intentPath, { target: input.target })
      await mkdir(input.target, { mode: 0o700 })
      await syncDatabasePath(dirname(input.target), true)
      await durableTransferRecord(recordPath, {
        target: input.target,
        identity: await identity(input.target),
      })
    },
    rollback: async () => {
      await validate()
      try {
        const intent = z
          .object({ target: z.literal(input.target) })
          .strict()
          .parse(JSON.parse(await readPrivateTransferFile(intentPath)))
        if (intent.target !== input.target) throw new DirectoryCutoverError()
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return
        throw error
      }
      let saved
      try {
        saved = await owner()
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
        if (await identity(input.target)) throw new DirectoryCutoverError()
        return
      }
      const current = await identity(input.target)
      if (!current) {
        if ((await identity(retired)) !== saved.identity) throw new DirectoryCutoverError()
        return
      }
      if (current !== saved.identity || (await readdir(input.target)).length || (await identity(retired)))
        throw new DirectoryCutoverError()
      await input.assertQuiescent()
      if (
        (await identity(input.target)) !== saved.identity ||
        (await readdir(input.target)).length ||
        (await identity(retired))
      )
        throw new DirectoryCutoverError()
      await rename(input.target, retired)
      await syncDatabasePath(dirname(input.target), true)
      await syncDatabasePath(input.stateDirectory, true)
    },
  }
}
