import type { MiddlewareHandler } from 'hono'
import { z } from 'zod'

type ClaudeRawOwnership = {
  readonly ownsInference: boolean
  readonly credentialIntegration: (id: string) => Promise<string | undefined>
}

class CredentialBodyError extends Error {
  constructor(readonly status: 400 | 413) {
    super('INVALID_CREDENTIAL_REQUEST')
  }
}

async function readCredentialBody(request: Request): Promise<Uint8Array> {
  if (!request.body) throw new CredentialBodyError(400)
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return new Uint8Array(Buffer.concat(chunks))
      size += value.byteLength
      if (size > 65536) {
        await reader.cancel()
        throw new CredentialBodyError(413)
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
}

export function protectRawClaudeMutations(policy: ClaudeRawOwnership): MiddlewareHandler {
  return async (c, next) => {
    if (!policy.ownsInference || ['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) return next()
    const path = new URL(c.req.url).pathname.replace(/^\/api\/opencode-proxy(?:\/repos\/[^/]+)?/, '')
    let integration: string | undefined
    try {
      const parts = path.split('/').filter(Boolean).map(decodeURIComponent)
      if (parts[0] !== 'api') return next()
      if (parts[1] === 'integration') integration = parts[2]
      if (parts[1] === 'credential') {
        if (parts[2]) {
          integration = await policy.credentialIntegration(parts[2])
          if (!integration) return c.json({ code: 'CREDENTIAL_OWNERSHIP_UNVERIFIED' }, 503)
        } else {
          const body = await readCredentialBody(c.req.raw)
          c.req.raw = new Request(c.req.raw, { body })
          let input: unknown
          try {
            input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body))
          } catch (error) {
            if (!(error instanceof Error)) throw error
            throw new CredentialBodyError(400)
          }
          const parsed = z.object({ integrationID: z.string().min(1) }).safeParse(input)
          if (!parsed.success) return c.json({ code: 'INVALID_CREDENTIAL_REQUEST' }, 400)
          integration = parsed.data.integrationID
        }
      }
    } catch (error) {
      if (error instanceof CredentialBodyError) return c.json({ code: error.message }, error.status)
      if (!(error instanceof Error)) throw error
      return c.json({ code: 'CREDENTIAL_OWNERSHIP_UNVERIFIED' }, 503)
    }
    if (integration === 'anthropic')
      return c.json(
        {
          code: 'CLAUDE_PROXY_MANAGED',
          error: 'Claude accounts are managed by CLIProxyAPI.',
        },
        409,
      )
    await next()
  }
}
