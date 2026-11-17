import { z } from 'zod'

const statuses = z.record(z.string(), z.object({ type: z.enum(['idle', 'busy', 'retry']) }))

export type DirectoryIdleObservation = {
  readonly directory: string
  readonly observedAt: number
  readonly state: 'idle' | 'busy' | 'unknown'
  readonly busySessions: number
}

export async function collectClaudeDirectoryIdle(
  directories: readonly string[],
  reader: (directory: string, signal: AbortSignal) => Promise<unknown>,
  signal: AbortSignal,
): Promise<readonly DirectoryIdleObservation[]> {
  const pending = [...new Set(directories)]
  const output: DirectoryIdleObservation[] = []
  let cursor = 0
  async function worker() {
    while (cursor < pending.length) {
      const directory = pending[cursor++]
      if (directory === undefined) return
      let busySessions = 0
      let state: DirectoryIdleObservation['state'] = 'unknown'
      try {
        signal.throwIfAborted()
        const parsed = statuses.safeParse(await reader(directory, signal))
        signal.throwIfAborted()
        if (parsed.success) {
          busySessions = Object.values(parsed.data).filter((entry) => entry.type !== 'idle').length
          state = busySessions ? 'busy' : 'idle'
        }
      } catch (error) {
        if (!(error instanceof Error)) throw error
      }
      output.push({ directory, observedAt: Date.now(), state, busySessions })
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, pending.length) }, () => worker()))
  return output
}
