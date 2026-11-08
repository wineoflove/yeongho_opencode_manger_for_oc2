import type { SystemStatusResponse } from '@opencode-manager/shared/schemas'

export const systemStatusFixture: SystemStatusResponse = {
  collectedAt: 1_800_000_000_000,
  platform: 'darwin',
  intervalSeconds: 30,
  overall: 'warning',
  cpu: { level: 'normal', cores: 18, load1: 12.59, load5: 13.9, load15: 10.58, ratio: 12.59 / 18 },
  memory: {
    level: 'warning',
    totalBytes: 32 * 1024 ** 3,
    freePercent: 63,
    usedPercent: 37,
    pressure: 'warning',
    swapUsedBytes: Math.round(10.1 * 1024 ** 3),
    swapTotalBytes: 12 * 1024 ** 3,
  },
  browsers: {
    level: 'normal',
    processes: 18,
    rssBytes: Math.round(736.6 * 1024 ** 2),
    categories: {
      chrome: { processes: 5, rssBytes: 300 * 1024 ** 2 },
      playwright: { processes: 0, rssBytes: 0 },
      headless: { processes: 13, rssBytes: Math.round(436.6 * 1024 ** 2) },
      agentBrowser: { processes: 0, rssBytes: 0 },
    },
  },
  errors: [],
}
