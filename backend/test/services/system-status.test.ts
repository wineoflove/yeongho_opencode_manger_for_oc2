import { afterEach, describe, expect, it, vi } from 'vitest'
import { SystemStatusResponseSchema } from '@opencode-manager/shared/schemas'
import { SystemStatusService } from '../../src/services/system-status'
import { logger } from '../../src/utils/logger'

const os = {
  cpus: () => Array.from({ length: 18 }, () => ({})),
  loadavg: () => [12.59, 13.9, 10.58],
  totalmem: () => 32 * 1024 ** 3,
}
const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const secret = '--token=SECRET123 /Users/someone/x'
const ps = [
  ...Array.from({ length: 5 }, () => `100 ${chrome}`),
  ...Array.from({ length: 13 }, () => `200 ${chrome} --headless`),
].join('\n')
const outputs: Record<string, string> = {
  'kern.memorystatus_level': '63',
  'kern.memorystatus_vm_pressure_level': '1',
  'vm.swapusage': 'total = 16384.00M  used = 10342.25M  free = 6041.75M',
}
const runner = (processes = ps) =>
  vi.fn(async (args: string[]) => (args[0] === 'ps' ? processes : (outputs[args[2] ?? ''] ?? '')))
const readFile = vi.fn(async (path: string) =>
  path === '/proc/meminfo'
    ? 'MemTotal: 1000 kB\nMemAvailable: 300 kB\nSwapTotal: 200 kB\nSwapFree: 50 kB\n'
    : 'some avg10=12.00 avg60=1.00 avg300=0.00 total=10\nfull avg10=80.0',
)

afterEach(() => vi.restoreAllMocks())

describe('SystemStatusService', () => {
  it('collects schema-valid darwin aggregates without retaining process details', async () => {
    const run = runner()
    const service = new SystemStatusService({ platform: 'darwin', run, os, readFile, now: () => 100 })
    const status = SystemStatusResponseSchema.parse(await service.getStatus())
    expect(status).toMatchObject({
      collectedAt: 100,
      platform: 'darwin',
      intervalSeconds: 30,
      overall: 'normal',
      errors: [],
      cpu: { cores: 18, ratio: 0.699, level: 'normal' },
      memory: { freePercent: 63, usedPercent: 37, level: 'normal', swapUsedBytes: 10342.25 * 1024 ** 2 },
      browsers: {
        processes: 18,
        rssBytes: 3100 * 1024,
        categories: {
          chrome: { processes: 5 },
          headless: { processes: 13 },
          playwright: { processes: 0 },
          agentBrowser: { processes: 0 },
        },
      },
    })
    expect(run).toHaveBeenCalledWith(['sysctl', '-n', 'kern.memorystatus_level'], { timeout: 2000 })
    expect(run).toHaveBeenCalledWith(['ps', '-axo', 'rss=,command='], { timeout: 3000 })
  })

  it('collects linux available memory, swap and first-line PSI', async () => {
    const run = runner('')
    const status = await new SystemStatusService({ platform: 'linux', run, os, readFile }).getStatus()
    expect(status.memory).toEqual({
      level: 'warning',
      totalBytes: 1024000,
      freePercent: 30,
      usedPercent: 70,
      pressure: 'warning',
      swapTotalBytes: 204800,
      swapUsedBytes: 153600,
    })
    expect(status.overall).toBe('warning')
    expect(run).toHaveBeenCalledWith(['ps', '-eo', 'rss=,args='], { timeout: 3000 })
  })

  it('shares the in-flight promise and caches for strictly less than five seconds', async () => {
    let time = 100
    const run = runner('')
    const service = new SystemStatusService({ platform: 'linux', run, os, readFile, now: () => time })
    const first = service.getStatus()
    expect(service.getStatus()).toBe(first)
    const result = await first
    time = 5099
    expect(await service.getStatus()).toBe(result)
    expect(run).toHaveBeenCalledTimes(1)
    time = 5100
    expect(await service.getStatus()).not.toBe(result)
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('returns only reason codes when sysctl and ps throw secret-bearing errors', async () => {
    const spies = (['info', 'warn', 'error', 'debug'] as const).map((method) => vi.spyOn(logger, method))
    const consoleSpies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((method) => vi.spyOn(console, method))
    const run = vi.fn(async (args: string[]) => {
      if (args[0] === 'ps' || args[2] === 'kern.memorystatus_level') throw new Error(secret)
      return outputs[args[2] ?? ''] ?? ''
    })
    const status = await new SystemStatusService({ platform: 'darwin', run, os, readFile }).getStatus()
    expect(status.memory.freePercent).toBeNull()
    expect(status.memory.usedPercent).toBeNull()
    expect(status.errors).toEqual(expect.arrayContaining(['SYSCTL_FAILED: kern.memorystatus_level', 'PS_FAILED']))
    expect(status.browsers).toMatchObject({ processes: 0, rssBytes: 0, level: 'unknown' })
    expect(
      JSON.stringify([status, ...spies.map((spy) => spy.mock.calls), ...consoleSpies.map((spy) => spy.mock.calls)]),
    ).not.toMatch(/SECRET123|\/Users\//)
  })

  it('classifies only browser executables in exclusive priority order and discards command lines', async () => {
    const processes = [
      `10 ${chrome} --headless --user-data-dir=/tmp/omowright-profile ${secret}`,
      '20 /cache/ms-playwright/chromium/chrome --headless',
      '30 /cache/chrome-headless-shell --type=renderer',
      `40 ${chrome} --headless=new`,
      `50 ${chrome} ${secret}`,
      '60 /opt/homebrew/bin/node /x/mcp.js --browser chromium',
      '70 /usr/bin/soffice --headless',
      `80 ${chrome} --user-data-dir=/tmp/agent-browser --headless`,
    ].join('\n')
    const status = await new SystemStatusService({
      platform: 'darwin',
      run: runner(processes),
      os,
      readFile,
    }).getStatus()
    expect(status.browsers.categories).toEqual({
      agentBrowser: { processes: 2, rssBytes: 90 * 1024 },
      playwright: { processes: 1, rssBytes: 20 * 1024 },
      headless: { processes: 2, rssBytes: 70 * 1024 },
      chrome: { processes: 1, rssBytes: 50 * 1024 },
    })
    expect(status.browsers.processes).toBe(6)
    expect(JSON.stringify(status)).not.toMatch(/SECRET123|\/Users\/|Google Chrome|--headless/)
  })

  it.each([
    [0.8, 'warning'],
    [1.2, 'critical'],
    [0, 'normal'],
  ] as const)('applies CPU ratio boundary %s', async (ratio, level) => {
    const status = await new SystemStatusService({
      platform: 'darwin',
      run: runner(''),
      os: { ...os, loadavg: () => [ratio * 18, 0, 0] },
      readFile,
    }).getStatus()
    expect(status.cpu.level).toBe(level)
  })

  it.each([
    [2, 'warning'],
    [4, 'critical'],
  ] as const)('applies browser RSS boundary %s GiB', async (gib, level) => {
    const status = await new SystemStatusService({
      platform: 'darwin',
      run: runner(`${gib * 1024 ** 2} ${chrome}`),
      os,
      readFile,
    }).getStatus()
    expect(status.browsers.level).toBe(level)
    expect(status.overall).toBe(level)
  })

  it('warns at eighty browser processes', async () => {
    const status = await new SystemStatusService({
      platform: 'darwin',
      run: runner(Array.from({ length: 80 }, () => `1 ${chrome}`).join('\n')),
      os,
      readFile,
    }).getStatus()
    expect(status.browsers.level).toBe('warning')
  })

  it.each([
    [25, 'normal'],
    [10, 'warning'],
    [9, 'critical'],
  ] as const)('falls back to available percent %s when PSI is missing', async (available, level) => {
    const read = async (path: string) => {
      if (path.includes('pressure')) throw new Error(secret)
      return `MemTotal: 100 kB\nMemAvailable: ${available} kB\nSwapTotal: 0 kB\nSwapFree: 0 kB`
    }
    const status = await new SystemStatusService({ platform: 'linux', run: runner(''), os, readFile: read }).getStatus()
    expect(status.memory.level).toBe(level)
    expect(status.memory.pressure).toBeNull()
    expect(status.errors).toEqual(['PROC_READ_FAILED: pressure'])
  })

  it('returns unknown memory when both proc reads fail', async () => {
    const status = await new SystemStatusService({
      platform: 'linux',
      run: runner(''),
      os,
      readFile: async () => {
        throw new Error(secret)
      },
    }).getStatus()
    expect(status.memory).toMatchObject({ level: 'unknown', totalBytes: null, freePercent: null, swapUsedBytes: null })
    expect(status.errors).toEqual(expect.arrayContaining(['PROC_READ_FAILED: meminfo', 'PROC_READ_FAILED: pressure']))
  })

  it('does not collect commands or files on unsupported platforms', async () => {
    const run = runner()
    const read = vi.fn(readFile)
    const status = await new SystemStatusService({ platform: 'win32', run, os, readFile: read }).getStatus()
    expect(status).toMatchObject({
      platform: 'other',
      overall: 'unknown',
      cpu: { load1: null, ratio: null },
      memory: { level: 'unknown' },
      browsers: { level: 'unknown' },
      errors: ['UNSUPPORTED_PLATFORM'],
    })
    expect(run).not.toHaveBeenCalled()
    expect(read).not.toHaveBeenCalled()
  })

  it.each([
    [0, 'normal'],
    [10, 'warning'],
    [40, 'critical'],
  ] as const)('applies linux PSI boundary %s', async (psi, level) => {
    const status = await new SystemStatusService({
      platform: 'linux',
      run: runner(''),
      os,
      readFile: async (path) => (path.includes('pressure') ? `some avg10=${psi} avg60=0` : readFile(path)),
    }).getStatus()
    expect(status.memory.pressure).toBe(level)
  })

  it.each([
    ['K', 1024],
    ['M', 1024 ** 2],
    ['G', 1024 ** 3],
    ['T', 1024 ** 4],
  ] as const)('parses swap unit %s', async (unit, bytes) => {
    const run = async (args: string[]) =>
      args[2] === 'vm.swapusage' ? `total = 2${unit} used = 1${unit}` : runner('')(args)
    const status = await new SystemStatusService({ platform: 'darwin', run, os, readFile }).getStatus()
    expect(status.memory.swapTotalBytes).toBe(2 * bytes)
    expect(status.memory.swapUsedBytes).toBe(bytes)
  })

  it('keeps unknown CPU out of overall and handles invalid sysctl output without leaking it', async () => {
    const status = await new SystemStatusService({
      platform: 'darwin',
      run: async (args) => (args[0] === 'ps' ? '' : secret),
      os: { ...os, cpus: () => [] },
      readFile,
    }).getStatus()
    expect(status.cpu).toMatchObject({ cores: null, ratio: null, level: 'unknown' })
    expect(status.memory).toMatchObject({ level: 'unknown', freePercent: null, pressure: null, swapUsedBytes: null })
    expect(status.overall).toBe('normal')
    expect(status.errors).toHaveLength(3)
    expect(JSON.stringify(status)).not.toMatch(/SECRET123|\/Users\//)
  })
})
