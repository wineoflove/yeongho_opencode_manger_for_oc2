import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  getRunDeadlineMs,
  RunDeadline,
  RunDeadlineAbortError,
  RUN_DEADLINE_ENV,
} from '../../src/services/schedule-run-deadline'

vi.mock('../../src/utils/logger', () => ({ logger: { warn: vi.fn() } }))

afterEach(() => {
  vi.unstubAllEnvs()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('schedule absolute deadline', () => {
  it('warns once for invalid settings without copying their values into logs', async () => {
    vi.resetModules()
    const deadlineModule = await import('../../src/services/schedule-run-deadline')
    const { logger } = await import('../../src/utils/logger')
    vi.mocked(logger.warn).mockClear()
    vi.stubEnv(RUN_DEADLINE_ENV, 'invalid-sensitive-fixture')
    expect(deadlineModule.getRunDeadlineMs()).toBe(120 * 60_000)
    expect(deadlineModule.getRunDeadlineMs()).toBe(120 * 60_000)
    expect(logger.warn).toHaveBeenCalledOnce()
    expect(JSON.stringify(vi.mocked(logger.warn).mock.calls)).not.toContain('invalid-sensitive-fixture')
  })

  it.each([
    { raw: undefined, minutes: 120 },
    { raw: '', minutes: 120 },
    { raw: '  ', minutes: 120 },
    { raw: '5', minutes: 5 },
    { raw: '1440', minutes: 1440 },
    { raw: ' 10 ', minutes: 10 },
    { raw: '1e1', minutes: 10 },
    { raw: '4', minutes: 120 },
    { raw: '1441', minutes: 120 },
    { raw: '5.5', minutes: 120 },
    { raw: 'NaN', minutes: 120 },
    { raw: 'Infinity', minutes: 120 },
  ])('resolves configuration $raw to $minutes minutes', ({ raw, minutes }) => {
    vi.stubEnv(RUN_DEADLINE_ENV, raw)
    expect(getRunDeadlineMs()).toBe(minutes * 60_000)
  })

  it('expires once at the original deadline despite successful intermediate work', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1000)
    const expire = vi.fn()
    const deadline = new RunDeadline(1100, expire)
    const operation = Promise.withResolvers<string>()
    const outcome = expect(deadline.race(operation.promise)).rejects.toMatchObject({ deadlineAt: 1100 })
    await vi.advanceTimersByTimeAsync(50)
    expect(await deadline.race(Promise.resolve('step'))).toBe('step')
    expect(expire).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(50)
    await outcome
    expect(expire).toHaveBeenCalledOnce()
    expect(deadline.signal.aborted).toBe(true)
    operation.resolve('late result')
    await vi.advanceTimersByTimeAsync(100)
    expect(expire).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not expire or abort after clearing the timer', async () => {
    vi.useFakeTimers()
    const expire = vi.fn()
    const deadline = new RunDeadline(Date.now() + 100, expire)
    deadline.clear()
    await vi.advanceTimersByTimeAsync(200)
    expect(expire).not.toHaveBeenCalled()
    expect(deadline.signal.aborted).toBe(false)
    expect(await deadline.race(Promise.resolve(7))).toBe(7)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('preserves operation failures and removes the abort listener', async () => {
    vi.useFakeTimers()
    const deadline = new RunDeadline(Date.now() + 100, vi.fn())
    const remove = vi.spyOn(deadline.signal, 'removeEventListener')
    const failure = new Error('operation failed')
    await expect(deadline.race(Promise.reject(failure))).rejects.toBe(failure)
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function))
    deadline.clear()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('expires an overdue deadline immediately and handles a later operation rejection', async () => {
    vi.useFakeTimers()
    const expire = vi.fn()
    const deadline = new RunDeadline(Date.now() - 1, expire)
    await vi.advanceTimersByTimeAsync(0)
    await expect(deadline.race(Promise.resolve('too late'))).rejects.toBeInstanceOf(RunDeadlineAbortError)
    const operation = Promise.withResolvers<never>()
    await expect(deadline.race(operation.promise)).rejects.toBeInstanceOf(RunDeadlineAbortError)
    operation.reject(new Error('late operation failure'))
    await vi.advanceTimersByTimeAsync(0)
    expect(expire).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })
})
