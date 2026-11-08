import { logger } from '../utils/logger'

export const RUN_DEADLINE_ENV = 'OCM_SCHEDULE_RUN_DEADLINE_MINUTES'
const MINUTE_MS = 60_000
const DEFAULT_DEADLINE_MINUTES = 120
let invalidValueWarned = false

export function getRunDeadlineMs(): number {
  const raw = process.env[RUN_DEADLINE_ENV]
  if (raw === undefined || raw.trim() === '') return DEFAULT_DEADLINE_MINUTES * MINUTE_MS
  const minutes = Number(raw)
  if (Number.isInteger(minutes) && minutes >= 5 && minutes <= 1440) return minutes * MINUTE_MS
  if (!invalidValueWarned) {
    invalidValueWarned = true
    logger.warn(`${RUN_DEADLINE_ENV} must be an integer from 5 to 1440; using ${DEFAULT_DEADLINE_MINUTES} minutes`)
  }
  return DEFAULT_DEADLINE_MINUTES * MINUTE_MS
}

export function buildRunDeadlineErrorText(deadlineMs: number): string {
  return `RUN_DEADLINE_EXCEEDED: the run exceeded ${Math.round(deadlineMs / MINUTE_MS)} minutes. Confirm any remaining session activity before retrying.`
}

export class RunDeadlineAbortError extends Error {
  constructor(readonly deadlineAt: number) {
    super('RUN_DEADLINE_EXCEEDED: the run deadline expired')
    this.name = 'RunDeadlineAbortError'
  }
}

export class RunDeadline {
  private readonly controller = new AbortController()
  private readonly timer: ReturnType<typeof setTimeout>
  private readonly failure: RunDeadlineAbortError

  constructor(
    readonly deadlineAt: number,
    onExpire: () => void,
  ) {
    this.failure = new RunDeadlineAbortError(deadlineAt)
    this.timer = setTimeout(
      () => {
        this.controller.abort(this.failure)
        onExpire()
      },
      Math.max(0, deadlineAt - Date.now()),
    )
  }

  get signal(): AbortSignal {
    return this.controller.signal
  }

  clear(): void {
    clearTimeout(this.timer)
  }

  async race<T>(operation: Promise<T>): Promise<T> {
    const expiration = Promise.withResolvers<never>()
    const onAbort = () => expiration.reject(this.failure)
    if (this.signal.aborted) onAbort()
    else this.signal.addEventListener('abort', onAbort, { once: true })
    try {
      return await Promise.race([expiration.promise, operation])
    } finally {
      this.signal.removeEventListener('abort', onAbort)
    }
  }
}
