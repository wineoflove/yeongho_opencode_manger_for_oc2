import { afterEach, expect, it, vi } from 'vitest'
import { PeriodicLaunchd } from '../../src/services/periodic-launchd'
import { periodicSuspensionStep } from '../../src/services/cutover-periodic-step'
import { runCutoverSteps } from '../../src/services/cutover-step-runner'

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

const unit = {
  label: 'io.wineoflove.ocm.backup-report',
  definition: '/synthetic/job.plist',
  sha256: 'a'.repeat(64),
}
const lifecycle = () =>
  new PeriodicLaunchd({
    stateDirectory: '/synthetic',
    persist: async () => {},
  })

it('leaves active work alone when waiting expires', async () => {
  vi.useFakeTimers()
  const service = lifecycle()
  vi.spyOn(service, 'inspect').mockResolvedValue({
    state: 'running',
    pid: 1234,
  })
  const stop = vi.spyOn(service, 'unregisterIdle').mockResolvedValue()
  const step = periodicSuspensionStep({
    name: 'suspend-backup-report',
    originallyRegistered: true,
    lifecycle: service,
    unit: () => unit,
    maximumWaitMs: 100,
    assertFenced: async () => {},
  })
  const rejected = expect(step.forward()).rejects.toMatchObject({
    code: 'WORK_ACTIVE',
  })
  await vi.advanceTimersByTimeAsync(150)
  await rejected
  expect(stop).not.toHaveBeenCalled()
})

it('waits for natural idle before unregistering and restores only a previously registered job', async () => {
  const service = lifecycle()
  vi.spyOn(service, 'inspect')
    .mockResolvedValueOnce({ state: 'running', pid: 1234 })
    .mockResolvedValueOnce({ state: 'idle', runs: 1, lastExitCode: 0 })
    .mockResolvedValue({ state: 'absent' })
  const stop = vi.spyOn(service, 'unregisterIdle').mockResolvedValue()
  const start = vi.spyOn(service, 'register').mockResolvedValue(unit)
  const step = periodicSuspensionStep({
    name: 'suspend-backup-report',
    originallyRegistered: true,
    lifecycle: service,
    unit: () => unit,
    maximumWaitMs: 1000,
    assertFenced: async () => {},
  })
  await step.forward()
  expect(stop).toHaveBeenCalledOnce()
  await step.rollback()
  expect(start).toHaveBeenCalledOnce()
})

it('preserves a foreign registration and reports rollback unverified when the original job was absent', async () => {
  const service = lifecycle()
  vi.spyOn(service, 'inspect').mockResolvedValue({
    state: 'idle',
    runs: 0,
    lastExitCode: undefined,
  })
  const start = vi.spyOn(service, 'register').mockResolvedValue(unit)
  const stop = vi.spyOn(service, 'unregisterIdle').mockResolvedValue()
  const step = periodicSuspensionStep({
    name: 'suspend-backup-report',
    originallyRegistered: false,
    lifecycle: service,
    unit: () => unit,
    maximumWaitMs: 1000,
    assertFenced: async () => {},
  })
  await expect(runCutoverSteps({ steps: [step], persist: async () => {} })).rejects.toMatchObject({
    rollback: 'unverified',
  })
  expect(start).not.toHaveBeenCalled()
  expect(stop).not.toHaveBeenCalled()
})

it('does not start a job that was originally absent', async () => {
  const service = lifecycle()
  vi.spyOn(service, 'inspect').mockResolvedValue({ state: 'absent' })
  const start = vi.spyOn(service, 'register').mockResolvedValue(unit)
  const step = periodicSuspensionStep({
    name: 'suspend-learning-cleanup',
    originallyRegistered: false,
    lifecycle: service,
    unit: () => unit,
    maximumWaitMs: 1000,
    assertFenced: async () => {},
  })
  await step.forward()
  await step.rollback()
  expect(start).not.toHaveBeenCalled()
})
