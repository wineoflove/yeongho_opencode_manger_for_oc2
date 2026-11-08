import { createOpenCodeApi } from '../../shared/src/opencode/index.ts'

/**
 * OpenCode 2 API client that reaches the Manager's OpenCode server through the internal-token proxy,
 * using the `OCM_INTERNAL_API_URL` and `OCM_INTERNAL_TOKEN` the Manager passes to OpenCode and its shell commands.
 */
export function openCodeApi(env = process.env, fetcher = fetch) {
  const internal = env.OCM_INTERNAL_API_URL
  const token = env.OCM_INTERNAL_TOKEN
  if (!internal || !token) throw new Error('OCM_INTERNAL_API_UNAVAILABLE')
  return createOpenCodeApi({
    baseUrl: new URL('/api/opencode-proxy', internal).href,
    fetch: fetcher,
    headers: { Authorization: `Bearer ${token}` },
  })
}
