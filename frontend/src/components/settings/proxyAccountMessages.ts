import { FetchError } from '@opencode-manager/shared'
import type { ClaudeProxyProvider } from '@/api/claudeProxy'
import { msg, t } from '@/i18n/translate'

/** Context of a failed CLIProxy request, which selects the wording of its error. */
export type ProxyErrorContext = 'list' | 'account' | 'login'

export const PROXY_PROVIDERS: readonly ClaudeProxyProvider[] = ['claude', 'openai']

export const PROXY_PROVIDER_NAMES: Readonly<Record<ClaudeProxyProvider, string>> = {
  claude: 'Claude',
  openai: 'OpenAI',
}

const reachability: Readonly<Record<string, string>> = {
  CLAUDE_PROXY_NOT_CONFIGURED: msg('CLIProxy is not configured on this server.'),
  UNAVAILABLE: msg('Could not reach CLIProxy. Try again in a moment.'),
  ACCESS_DENIED: msg('CLIProxy refused the management request. Check the CLIProxy management key.'),
  TIMEOUT: msg('CLIProxy did not answer in time. Try again in a moment.'),
}

const messages: Readonly<Record<ProxyErrorContext, Readonly<Record<string, string>>>> = {
  list: reachability,
  account: {
    ...reachability,
    ACCOUNT_NOT_FOUND: msg('This account no longer exists in CLIProxy. The list has been refreshed.'),
  },
  login: {
    ...reachability,
    INVALID_REDIRECT: msg(
      'This is not the address from the sign-in page. After signing in, copy the full URL from the address bar.',
    ),
    LOGIN_DENIED: msg('The sign-in was denied or cancelled. Open the sign-in page and try again.'),
    LOGIN_FAILED: msg('CLIProxy could not register the account. Sign in again.'),
    LOGIN_PENDING: msg('CLIProxy is still confirming the account. Check the account list in a moment.'),
    TIMEOUT: msg('CLIProxy is still confirming the account. Check the account list in a moment.'),
  },
}

const fallbacks: Readonly<Record<ProxyErrorContext, string>> = {
  list: msg('Could not load AI accounts from CLIProxy.'),
  account: msg('The change could not be confirmed. Refresh the list and try again.'),
  login: msg('Could not add the account. Try again.'),
}

/** Error code reported by the Manager API, if the error came from it. */
export function proxyErrorCode(error: unknown): string | undefined {
  return error instanceof FetchError ? error.code : undefined
}

/** Friendly translated text for a failed CLIProxy request; upstream messages are never shown. */
export function proxyErrorMessage(error: unknown, context: ProxyErrorContext): string {
  const code = proxyErrorCode(error)
  return t((code && messages[context][code]) || fallbacks[context])
}
