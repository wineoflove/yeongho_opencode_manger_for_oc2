import { isAbsolute, normalize } from 'node:path'
import { applyEdits, modify, parse, parseTree, type Node, type ParseError } from 'jsonc-parser'
import { z } from 'zod'

const settingsSchema = z.record(z.string(), z.unknown())
const providerSchema = z.object({ settings: settingsSchema.optional() }).passthrough()
const configSchema = z
  .object({
    provider: z.never().optional(),
    providers: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough()
const routingKeys = new Set(['baseURL', 'apiKey', 'accessToken', 'authToken', 'accountPool', 'credentialID'])

export class ClaudeRoutingConfigError extends Error {
  constructor(readonly code: 'INVALID_CONFIG' | 'INVALID_TARGET' | 'CONFLICTING_OVERRIDE') {
    super(code)
    this.name = 'ClaudeRoutingConfigError'
  }
}

function assertUniqueKeys(node: Node): void {
  if (node.type === 'object') {
    const keys = new Set<unknown>()
    for (const property of node.children ?? []) {
      const key: unknown = property.children?.[0]?.value
      if (keys.has(key)) throw new ClaudeRoutingConfigError('INVALID_CONFIG')
      keys.add(key)
    }
  }
  for (const child of node.children ?? []) assertUniqueKeys(child)
}

function hasRoutingOverride(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasRoutingOverride)
  const object = settingsSchema.safeParse(value)
  if (!object.success) return false
  return Object.entries(object.data).some(
    ([key, nested]) =>
      routingKeys.has(key) ||
      key.toLowerCase() === 'authorization' ||
      key.toLowerCase() === 'x-api-key' ||
      hasRoutingOverride(nested),
  )
}

export function prepareClaudeRoutingConfig(text: string, baseURL: string, ingressKeyFile: string): string {
  if (!URL.canParse(baseURL)) throw new ClaudeRoutingConfigError('INVALID_TARGET')
  const target = new URL(baseURL)
  if (
    target.protocol !== 'http:' ||
    target.hostname !== '127.0.0.1' ||
    target.username ||
    target.password ||
    target.search ||
    target.hash ||
    target.pathname !== '/api/claude-inference/v1' ||
    !isAbsolute(ingressKeyFile) ||
    normalize(ingressKeyFile) !== ingressKeyFile ||
    /[{}\r\n\0]/.test(ingressKeyFile)
  )
    throw new ClaudeRoutingConfigError('INVALID_TARGET')
  const errors: ParseError[] = []
  const tree = parseTree(text, errors, { allowTrailingComma: true })
  if (!tree || errors.length) throw new ClaudeRoutingConfigError('INVALID_CONFIG')
  assertUniqueKeys(tree)
  const parsed = configSchema.safeParse(parse(text))
  if (!parsed.success) throw new ClaudeRoutingConfigError('INVALID_CONFIG')
  const anthropic = parsed.data.providers?.anthropic
  const provider = providerSchema.safeParse(anthropic === undefined ? {} : anthropic)
  if (!provider.success) throw new ClaudeRoutingConfigError('INVALID_CONFIG')
  const { settings = {}, ...rest } = provider.data
  if (hasRoutingOverride(rest) || hasRoutingOverride(settings.headers))
    throw new ClaudeRoutingConfigError('CONFLICTING_OVERRIDE')
  const changes: ReadonlyArray<readonly [string, string | undefined]> = [
    ['baseURL', baseURL],
    ['apiKey', `{file:${ingressKeyFile}}`],
    ['accessToken', undefined],
    ['authToken', undefined],
    ['accountPool', undefined],
  ]
  return changes.reduce(
    (result, [key, value]) =>
      applyEdits(
        result,
        modify(result, ['providers', 'anthropic', 'settings', key], value, {
          formattingOptions: { insertSpaces: true, tabSize: 2 },
        }),
      ),
    text,
  )
}
