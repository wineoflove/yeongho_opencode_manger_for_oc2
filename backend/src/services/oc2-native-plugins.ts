import { z } from 'zod'

const pluginSchema = z.union([
  z.string().min(1),
  z
    .object({
      package: z.string().min(1),
      options: z.record(z.string(), z.unknown()).optional(),
    })
    .strict(),
])
const configSchema = z
  .object({
    plugin: z.never().optional(),
    plugins: z.array(pluginSchema).optional(),
  })
  .passthrough()

export class Oc2NativePluginsError extends Error {
  constructor() {
    super('INVALID_NATIVE_PLUGIN_CONFIG')
    this.name = 'Oc2NativePluginsError'
  }
}

export function selectOc2NativePlugins(input: unknown) {
  const parsed = configSchema.safeParse(input)
  if (!parsed.success) throw new Oc2NativePluginsError()
  const config = parsed.data
  const removed: string[] = []
  if (config.plugins === undefined) return { config, removed }
  const plugins = config.plugins.filter((entry) => {
    const target = typeof entry === 'string' ? entry : entry.package
    if (target !== 'oh-my-openagent@5.1.60') return true
    removed.push(target)
    return false
  })
  return { config: { ...config, plugins }, removed }
}
