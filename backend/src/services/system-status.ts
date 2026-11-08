import { cpus, loadavg, totalmem } from 'node:os'
import { readFile } from 'node:fs/promises'
import type {
  SystemBrowsers,
  SystemCpu,
  SystemLevel,
  SystemMemory,
  SystemStatusResponse,
} from '@opencode-manager/shared/schemas'
import { executeCommand } from '../utils/process'

export const SYSTEM_STATUS_THRESHOLDS = {
  cpuWarnRatio: 0.8,
  cpuCritRatio: 1.2,
  memWarnFreePercent: 25,
  memCritFreePercent: 10,
  browserWarnBytes: 2 * 1024 ** 3,
  browserCritBytes: 4 * 1024 ** 3,
  browserWarnProcesses: 80,
  linuxPsiWarn: 10,
  linuxPsiCrit: 40,
} as const

interface SystemStatusOptions {
  readonly platform?: string
  readonly run?: (args: string[], options: { timeout: number }) => Promise<string>
  readonly os?: { cpus: () => readonly unknown[]; loadavg: () => readonly number[]; totalmem: () => number }
  readonly readFile?: (path: string, encoding: 'utf8') => Promise<string>
  readonly now?: () => number
}

const thresholds = SYSTEM_STATUS_THRESHOLDS
const emptyMemory = (): SystemMemory => ({
  level: 'unknown',
  totalBytes: null,
  freePercent: null,
  usedPercent: null,
  pressure: null,
  swapUsedBytes: null,
  swapTotalBytes: null,
})
const emptyBrowsers = (): SystemBrowsers => ({
  level: 'unknown',
  processes: 0,
  rssBytes: 0,
  categories: {
    chrome: { processes: 0, rssBytes: 0 },
    playwright: { processes: 0, rssBytes: 0 },
    headless: { processes: 0, rssBytes: 0 },
    agentBrowser: { processes: 0, rssBytes: 0 },
  },
})
const nonnegative = (value: number | undefined): number | null =>
  value !== undefined && Number.isFinite(value) && value >= 0 ? value : null
const memoryLevel = (memory: SystemMemory): SystemLevel =>
  memory.pressure ??
  (memory.freePercent === null
    ? 'unknown'
    : memory.freePercent >= thresholds.memWarnFreePercent
      ? 'normal'
      : memory.freePercent >= thresholds.memCritFreePercent
        ? 'warning'
        : 'critical')

async function collectValue<Value>(
  read: () => Promise<string>,
  parse: (text: string) => Value | null,
  code: string,
  errors: string[],
): Promise<Value | null> {
  try {
    const value = parse(await read())
    if (value !== null) return value
  } catch {
    errors.push(code)
    return null
  }
  errors.push(code)
  return null
}

export class SystemStatusService {
  private readonly platform: SystemStatusResponse['platform']
  private readonly run: NonNullable<SystemStatusOptions['run']>
  private readonly os: NonNullable<SystemStatusOptions['os']>
  private readonly readFile: NonNullable<SystemStatusOptions['readFile']>
  private readonly now: () => number
  private cached: SystemStatusResponse | undefined
  private pending: Promise<SystemStatusResponse> | undefined

  constructor(options: SystemStatusOptions = {}) {
    const platform = options.platform ?? process.platform
    this.platform = platform === 'darwin' || platform === 'linux' ? platform : 'other'
    this.run = options.run ?? ((args, { timeout }) => executeCommand(args, { silent: true, timeout }))
    this.os = options.os ?? { cpus, loadavg, totalmem }
    this.readFile = options.readFile ?? readFile
    this.now = options.now ?? Date.now
  }

  getStatus(): Promise<SystemStatusResponse> {
    if (this.pending) return this.pending
    if (this.cached && this.now() - this.cached.collectedAt < 5000) return Promise.resolve(this.cached)
    this.pending = this.collect()
      .then((status) => {
        this.cached = status
        return status
      })
      .finally(() => {
        this.pending = undefined
      })
    return this.pending
  }

  private async collect(): Promise<SystemStatusResponse> {
    const errors: string[] = []
    const cores = this.os.cpus().length || null
    const loads = this.platform === 'other' ? [] : this.os.loadavg()
    const load1 = nonnegative(loads[0])
    const ratio = load1 !== null && cores !== null ? Math.round((load1 / cores) * 1000) / 1000 : null
    const cpu: SystemCpu = {
      cores,
      load1,
      load5: nonnegative(loads[1]),
      load15: nonnegative(loads[2]),
      ratio,
      level:
        ratio === null
          ? 'unknown'
          : ratio < thresholds.cpuWarnRatio
            ? 'normal'
            : ratio < thresholds.cpuCritRatio
              ? 'warning'
              : 'critical',
    }
    const [memory, browsers] =
      this.platform === 'other'
        ? [emptyMemory(), emptyBrowsers()]
        : await Promise.all([this.collectMemory(errors), this.collectBrowsers(errors)])
    if (this.platform === 'other') errors.push('UNSUPPORTED_PLATFORM')
    const levels = [cpu.level, memory.level, browsers.level]
    const overall = (['critical', 'warning', 'normal'] as const).find((level) => levels.includes(level)) ?? 'unknown'
    return {
      collectedAt: this.now(),
      platform: this.platform,
      intervalSeconds: 30,
      overall,
      cpu,
      memory,
      browsers,
      errors,
    }
  }

  private async collectMemory(errors: string[]): Promise<SystemMemory> {
    const memory = emptyMemory()
    if (this.platform === 'darwin') {
      const sysctl = <Value>(key: string, parse: (text: string) => Value | null) =>
        collectValue(() => this.run(['sysctl', '-n', key], { timeout: 2000 }), parse, `SYSCTL_FAILED: ${key}`, errors)
      const [freePercent, pressure, swap] = await Promise.all([
        sysctl('kern.memorystatus_level', (text) =>
          /^\d+$/.test(text.trim()) && Number(text) <= 100 ? Number(text) : null,
        ),
        sysctl('kern.memorystatus_vm_pressure_level', (text) => {
          const value = text.trim()
          return value === '1' ? 'normal' : value === '2' ? 'warning' : value === '4' ? 'critical' : null
        }),
        sysctl('vm.swapusage', (text) => {
          const match = /total = ([\d.]+)([KMGT])\s+used = ([\d.]+)([KMGT])/.exec(text)
          if (!match) return null
          const total = nonnegative(Number(match[1]) * 1024 ** ('KMGT'.indexOf(match[2] ?? '') + 1))
          const used = nonnegative(Number(match[3]) * 1024 ** ('KMGT'.indexOf(match[4] ?? '') + 1))
          return total === null || used === null ? null : { total: Math.round(total), used: Math.round(used) }
        }),
      ])
      memory.totalBytes = this.os.totalmem()
      memory.freePercent = freePercent
      memory.pressure = pressure
      memory.swapTotalBytes = swap?.total ?? null
      memory.swapUsedBytes = swap?.used ?? null
    } else {
      const [info, pressure] = await Promise.all([
        collectValue(
          () => this.readFile('/proc/meminfo', 'utf8'),
          (text) => {
            const values = Object.fromEntries(
              [...text.matchAll(/^(MemTotal|MemAvailable|SwapTotal|SwapFree):\s+(\d+) kB$/gm)].map((match) => [
                match[1],
                Number(match[2]),
              ]),
            )
            const { MemTotal: total, MemAvailable: available, SwapTotal: swapTotal, SwapFree: swapFree } = values
            if (
              total === undefined ||
              total <= 0 ||
              available === undefined ||
              available > total ||
              swapTotal === undefined ||
              swapFree === undefined ||
              swapFree > swapTotal
            )
              return null
            return {
              totalBytes: total * 1024,
              freePercent: Math.round((available / total) * 100),
              swapTotalBytes: swapTotal * 1024,
              swapUsedBytes: (swapTotal - swapFree) * 1024,
            }
          },
          'PROC_READ_FAILED: meminfo',
          errors,
        ),
        collectValue(
          () => this.readFile('/proc/pressure/memory', 'utf8'),
          (text) => {
            const match = /^some avg10=([\d.]+)/.exec(text)
            const psi = match ? nonnegative(Number(match[1])) : null
            return psi === null
              ? null
              : psi < thresholds.linuxPsiWarn
                ? 'normal'
                : psi < thresholds.linuxPsiCrit
                  ? 'warning'
                  : 'critical'
          },
          'PROC_READ_FAILED: pressure',
          errors,
        ),
      ])
      if (info) Object.assign(memory, info)
      memory.pressure = pressure
    }
    memory.usedPercent = memory.freePercent === null ? null : 100 - memory.freePercent
    memory.level = memoryLevel(memory)
    return memory
  }

  private async collectBrowsers(errors: string[]): Promise<SystemBrowsers> {
    const result = await collectValue(
      () =>
        this.run(this.platform === 'darwin' ? ['ps', '-axo', 'rss=,command='] : ['ps', '-eo', 'rss=,args='], {
          timeout: 3000,
        }),
      (text) => {
        const browsers = emptyBrowsers()
        for (const line of text.split('\n')) {
          const match = /^\s*(\d+)\s+(.*)$/.exec(line)
          if (!match || !match[2]) continue
          const command = match[2]
          const exePart = command.split(' -', 1)[0] ?? ''
          if (
            !/(Google Chrome|Chromium|Microsoft Edge|Brave Browser|chrome-headless-shell)|[\\/](chrome|chromium|headless_shell)$/i.test(
              exePart,
            )
          )
            continue
          const category = /agent-browser|[\\/]omowright-/i.test(command)
            ? 'agentBrowser'
            : /[\\/]ms-playwright[\\/]/i.test(command)
              ? 'playwright'
              : /--headless(=\S+)?(\s|$)/i.test(command) || /chrome-headless-shell/i.test(exePart)
                ? 'headless'
                : 'chrome'
          const rssBytes = Number(match[1]) * 1024
          browsers.categories[category].processes++
          browsers.categories[category].rssBytes += rssBytes
          browsers.processes++
          browsers.rssBytes += rssBytes
        }
        browsers.level =
          browsers.rssBytes >= thresholds.browserCritBytes
            ? 'critical'
            : browsers.rssBytes >= thresholds.browserWarnBytes || browsers.processes >= thresholds.browserWarnProcesses
              ? 'warning'
              : 'normal'
        return browsers
      },
      'PS_FAILED',
      errors,
    )
    return result ?? emptyBrowsers()
  }
}
