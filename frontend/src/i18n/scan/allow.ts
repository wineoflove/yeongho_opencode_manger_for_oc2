import type { AllowedText } from './allow/core'
import { coreAllowed } from './allow/core'
import { messagesAllowed } from './allow/messages'
import { miscAllowed } from './allow/misc'
import { reposAllowed } from './allow/repos'
import { schedulesAllowed } from './allow/schedules'
import { sessionsAllowed } from './allow/sessions'
import { settingsAllowed } from './allow/settings'
import { settingsIntegrationsAllowed } from './allow/settings-integrations'
import { shellAllowed } from './allow/shell'
import { statsAllowed } from './allow/stats'
import { systemAllowed } from './allow/system'

const NAMES =
  'OpenCode Manager|OpenCode|OCM|OMO|MCP|LSP|Git|GitHub|OAuth|SSH|API|URL|JSON|YAML|CPU|PWA|TTS|STT|Anthropic|OpenAI|Claude|GPT|Codex|Chrome|Playwright|Bash|ID|LIVE|English|cron|Linux|PSI'
const KEYS = 'Ctrl|Shift|Alt|Cmd|Esc|Enter|Tab|Escape|Backspace|ArrowUp|ArrowDown|ArrowLeft|ArrowRight'
const SYMBOLS = String.raw`[\d\s.,:;%×·→…+\-/()<>=#~|]`

export const ALLOWED_TEXT: readonly RegExp[] = [
  new RegExp(`^(?:(?:${NAMES})(?![A-Za-z])|${SYMBOLS})+$`),
  new RegExp(`^(?:(?:${KEYS})(?![A-Za-z])|[A-Z0-9](?![A-Za-z])|${SYMBOLS})+$`),
  new RegExp(String.raw`^(?:KB|MB|GB|TB|ms|\{\w+\}|${SYMBOLS})+$`),
]

export const ALLOWED_FINDINGS: readonly AllowedText[] = [
  ...coreAllowed,
  ...schedulesAllowed,
  ...statsAllowed,
  ...systemAllowed,
  ...shellAllowed,
  ...sessionsAllowed,
  ...reposAllowed,
  ...settingsAllowed,
  ...settingsIntegrationsAllowed,
  ...messagesAllowed,
  ...miscAllowed,
]
