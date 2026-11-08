import type { CommandInfo } from '@opencode-manager/shared/opencode'
import { msg } from '@/i18n/translate'

export const BUILTIN_COMMAND_ACTIONS = [
  'showSessions',
  'showModels',
  'newSession',
  'toggleDetails',
  'exportSession',
  'copyTranscript',
  'compact',
  'askSideQuestion',
  'renameSession',
  'forkSession',
  'jumpToMessage',
  'undo',
  'redo',
  'cycleAgent',
  'cycleVariant',
  'showMcp',
  'showSkills',
  'showSettings',
  'connectProvider',
  'showWalkthrough',
] as const

type BuiltinCommandAction = (typeof BUILTIN_COMMAND_ACTIONS)[number]

type CommandActionHandler = (argument: string) => void | Promise<void>

export type CommandActions = Record<BuiltinCommandAction, CommandActionHandler>

export type PageCommandActions = Omit<CommandActions, 'cycleAgent' | 'cycleVariant'>

interface BuiltinCommand extends CommandInfo {
  action: BuiltinCommandAction
  keepsPrompt?: boolean
}

export const BUILTIN_COMMANDS: readonly BuiltinCommand[] = [
  { name: 'help', description: msg('Show the help dialog'), action: 'showSettings' },
  { name: 'new', description: msg('Start a new session'), action: 'newSession' },
  { name: 'clear', description: msg('Start a new session (alias for /new)'), action: 'newSession' },
  { name: 'sessions', description: msg('List and switch between sessions'), action: 'showSessions' },
  { name: 'resume', description: msg('List and switch between sessions (alias for /sessions)'), action: 'showSessions' },
  { name: 'continue', description: msg('List and switch between sessions (alias for /sessions)'), action: 'showSessions' },
  { name: 'models', description: msg('List available models'), action: 'showModels' },
  { name: 'model', description: msg('Choose a model'), action: 'showModels' },
  { name: 'agent', description: msg('Switch to the next primary agent'), action: 'cycleAgent' },
  { name: 'variants', description: msg('Cycle the model reasoning variant'), action: 'cycleVariant' },
  { name: 'export', description: msg('Export current conversation to Markdown'), action: 'exportSession' },
  { name: 'copy', description: msg('Copy the session transcript to the clipboard'), action: 'copyTranscript' },
  { name: 'compact', description: msg('Compact the current session'), action: 'compact' },
  { name: 'btw', description: msg('Ask a side question without adding it to the conversation'), action: 'askSideQuestion' },
  { name: 'rename', description: msg('Rename the session, or regenerate its title when no title is given'), action: 'renameSession' },
  { name: 'fork', description: msg('Fork the session from a chosen message'), action: 'forkSession' },
  { name: 'timeline', description: msg('Jump to a message in the conversation'), action: 'jumpToMessage' },
  { name: 'undo', description: msg('Undo last message in the conversation'), action: 'undo', keepsPrompt: true },
  { name: 'redo', description: msg('Redo a previously undone message'), action: 'redo', keepsPrompt: true },
  { name: 'details', description: msg('Toggle tool execution details'), action: 'toggleDetails' },
  { name: 'mcp', description: msg('Manage MCP servers'), action: 'showMcp' },
  { name: 'skills', description: msg('Load a skill'), action: 'showSkills' },
  { name: 'walkthrough', description: msg('Build an interactive walkthrough of the session changes'), action: 'showWalkthrough' },
  { name: 'settings', description: msg('Open settings'), action: 'showSettings' },
  { name: 'connect', description: msg('Connect a provider'), action: 'connectProvider' },
]

export function isBuiltinCommand(command: CommandInfo): command is BuiltinCommand {
  return 'action' in command
}

const MANAGER_ONLY_COMMAND_ACTIONS: ReadonlySet<BuiltinCommandAction> = new Set([
  'showWalkthrough',
])

/**
 * Built-in composer commands for a server scope. Commands backed by Manager-only features are omitted for
 * linked OpenCode servers; MCP, skills, and the session picker stay because their views work against the
 * linked server.
 */
export function getBuiltinCommands(isLocalServer: boolean): readonly BuiltinCommand[] {
  if (isLocalServer) return BUILTIN_COMMANDS
  return BUILTIN_COMMANDS.filter((command) => !MANAGER_ONLY_COMMAND_ACTIONS.has(command.action))
}
