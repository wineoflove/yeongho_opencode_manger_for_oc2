import { z } from 'zod'

export const SystemLevelSchema = z.enum(['normal', 'warning', 'critical', 'unknown'])
export const SystemCpuSchema = z.object({
  level: SystemLevelSchema,
  cores: z.number().int().positive().nullable(),
  load1: z.number().nonnegative().nullable(),
  load5: z.number().nonnegative().nullable(),
  load15: z.number().nonnegative().nullable(),
  ratio: z.number().nonnegative().nullable(),
})
export const SystemMemorySchema = z.object({
  level: SystemLevelSchema,
  totalBytes: z.number().int().nullable(),
  freePercent: z.number().min(0).max(100).nullable(),
  usedPercent: z.number().min(0).max(100).nullable(),
  pressure: z.enum(['normal', 'warning', 'critical']).nullable(),
  swapUsedBytes: z.number().int().nullable(),
  swapTotalBytes: z.number().int().nullable(),
})
export const SystemBrowserCategorySchema = z.object({
  processes: z.number().int().nonnegative(),
  rssBytes: z.number().int().nonnegative(),
})
export const SystemBrowsersSchema = SystemBrowserCategorySchema.extend({
  level: SystemLevelSchema,
  categories: z.object({
    chrome: SystemBrowserCategorySchema,
    playwright: SystemBrowserCategorySchema,
    headless: SystemBrowserCategorySchema,
    agentBrowser: SystemBrowserCategorySchema,
  }),
})
export const SystemStatusResponseSchema = z.object({
  collectedAt: z.number(),
  platform: z.enum(['darwin', 'linux', 'other']),
  intervalSeconds: z.literal(30),
  overall: SystemLevelSchema,
  cpu: SystemCpuSchema,
  memory: SystemMemorySchema,
  browsers: SystemBrowsersSchema,
  errors: z.array(z.string().max(120)).max(10),
})

export type SystemLevel = z.infer<typeof SystemLevelSchema>
export type SystemCpu = z.infer<typeof SystemCpuSchema>
export type SystemMemory = z.infer<typeof SystemMemorySchema>
export type SystemBrowserCategory = z.infer<typeof SystemBrowserCategorySchema>
export type SystemBrowsers = z.infer<typeof SystemBrowsersSchema>
export type SystemStatusResponse = z.infer<typeof SystemStatusResponseSchema>
