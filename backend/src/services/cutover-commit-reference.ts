import { isAbsolute, join } from 'node:path'
import { lstat, readdir, realpath } from 'node:fs/promises'
import { encodeCutoverJournalRecord } from './cutover-journal-store'
import { runCutoverSteps } from './cutover-step-runner'

export async function predictCutoverCommit(directory: string, stepNames: readonly string[]) {
  if (!isAbsolute(directory)) throw new Error('COMMIT_DIRECTORY_REQUIRED')
  const identity = await lstat(directory)
  if (
    (await realpath(directory)) !== directory ||
    !identity.isDirectory() ||
    identity.uid !== process.getuid?.() ||
    identity.mode & 0o077 ||
    (await readdir(directory)).length
  )
    throw new Error('FRESH_COMMIT_DIRECTORY_REQUIRED')
  let sequence = 0
  let previous: string | null = null
  let committed: { path: string; sha256: string } | undefined
  await runCutoverSteps({
    steps: stepNames.map((name) => ({
      name,
      forward: async () => {},
      rollback: async () => {},
    })),
    persist: async (state) => {
      const record = encodeCutoverJournalRecord(++sequence, previous, state)
      previous = record.sha256
      if (state.phase === 'committed')
        committed = {
          path: join(directory, record.filename),
          sha256: record.sha256,
        }
    },
  })
  if (!committed) throw new Error('COMMIT_REFERENCE_UNVERIFIED')
  return {
    ...committed,
    plan: [...stepNames],
    journalRecords: sequence,
    activationAuthorized: false as const,
  }
}
