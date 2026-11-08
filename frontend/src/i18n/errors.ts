import { msg, t } from './translate'

export interface DescribedError {
  readonly title: string
  readonly detail: string | null
}

const OCM_CODE_TITLES: ReadonlyArray<readonly [string, string]> = [
  ['AGENT_NOT_AVAILABLE', msg('The agent is not available')],
  ['AGENT_CHECK_FAILED', msg('Could not check the agent')],
  ['RUN_DEADLINE_EXCEEDED', msg('The run exceeded its time limit')],
  ['USAGE_SESSION_NOT_FOUND', msg('The usage session was not found')],
  ['USAGE_SOURCE_INCOMPATIBLE', msg('The usage data source is not compatible')],
  ['USAGE_SNAPSHOT_FAILED', msg('Could not read usage data')],
  ['WORKFLOW_SOURCE_INCOMPATIBLE', msg('The workflow data source is not compatible')],
  ['OCM_OUTCOME_NO_RUNNING_RUN', msg('There is no run in progress')],
  ['SYSTEM_STATUS_INVALID', msg('System status data is invalid')],
  ['LEARNING_RECORD_', msg('The learning record request failed')],
]

const OPENCODE_ERROR_TITLES: Readonly<Record<string, string>> = {
  ProviderAuthError: msg('Provider authentication failed'),
  UnknownError: msg('An unknown error occurred'),
  MessageOutputLengthError: msg('The response exceeded the output length limit'),
  MessageAbortedError: msg('The message was aborted'),
  APIError: msg('The API request failed'),
}

export function describeError(message: string): DescribedError {
  const codeTitle = OCM_CODE_TITLES.find(([code]) => message.startsWith(code))?.[1]
  const title =
    codeTitle ?? (Object.hasOwn(OPENCODE_ERROR_TITLES, message) ? OPENCODE_ERROR_TITLES[message] : undefined)
  return { title: t(title ?? msg('Request failed')), detail: message }
}
