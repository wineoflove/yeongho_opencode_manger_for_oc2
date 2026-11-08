import { basename } from 'node:path'
import { createHash } from 'node:crypto'
import type { PreparedWorkflowToolPart, WorkflowSession, WorkflowToolPart } from './workflow-types'

export function prepareWorkflowToolPart(part: WorkflowToolPart): PreparedWorkflowToolPart {
  const bashFamily = part.tool === 'bash' ? getBashFamily(part.command ?? '') : 'other'
  return {
    id: part.id,
    sessionId: part.sessionId,
    messageId: part.messageId,
    time: part.time,
    tool: part.tool,
    status: part.status,
    error: part.error,
    filePath: part.filePath,
    exit: part.exit,
    guardId: part.guardId,
    repeatKey: createHash('sha256')
      .update(JSON.stringify([part.sessionId, part.tool, `${part.inputHead ?? ''}:${part.inputLength}`]), 'utf16le')
      .digest('hex'),
    inputPreview: Buffer.from(redactInputPreview(part.inputHead ?? ''), 'utf16le').toString('utf16le'),
    bashFamily,
    bashTimeout: part.tool === 'bash' && isBashTimeout(part, bashFamily),
  }
}

export function stripBashPrefixes(command: string): string[] {
  const tokens: { value: string; operator: boolean }[] = []
  let value = ''
  let started = false
  let quote = ''
  for (let index = 0; index < command.length; index++) {
    const char = command[index] ?? ''
    if (char === '\\' && quote !== "'") {
      value += command[++index] ?? ''
      started = true
    } else if (quote) {
      if (char === quote) quote = ''
      else value += char
    } else if (char === '"' || char === "'") {
      quote = char
      started = true
    } else if (/\s/.test(char) || char === ';' || char === '&' || char === '|') {
      if (started) tokens.push({ value, operator: false })
      value = ''
      started = false
      if (!/\s/.test(char)) {
        const operator = command[index + 1] === char && char !== ';' ? char + command[++index] : char
        tokens.push({ value: operator, operator: true })
      }
    } else {
      value += char
      started = true
    }
  }
  if (started) tokens.push({ value, operator: false })
  let offset = 0
  while (offset < tokens.length) {
    const token = tokens[offset]
    if (!token || token.operator) break
    if (token.value === 'export') {
      const end = tokens.findIndex((item, index) => index > offset && item.operator)
      if (end < 0 || ![';', '&&'].includes(tokens[end]?.value ?? '')) break
      offset = end + 1
    } else if (
      token.value === 'cd' &&
      !tokens[offset + 1]?.operator &&
      tokens[offset + 2]?.operator &&
      tokens[offset + 2]?.value === '&&'
    ) {
      offset += 3
    } else if (token.value === 'env' || /^[A-Za-z_][A-Za-z0-9_]*=/.test(token.value)) {
      offset++
    } else break
  }
  return tokens.slice(offset).map((token) => token.value)
}

const bashFamilies = new Set([
  'curl',
  'cat',
  'python3',
  'node',
  'bun',
  'sqlite3',
  'jq',
  'gh',
  'git',
  'rg',
  'grep',
  'sed',
  'ls',
  'find',
  'head',
  'tail',
  'npm/pnpm',
  'opencode',
  'lsof',
  'ps',
  'kill',
])

export function getBashFamily(command: string): string {
  const executable = basename(stripBashPrefixes(command)[0] ?? '')
  const family = executable === 'npm' || executable === 'pnpm' ? 'npm/pnpm' : executable
  return bashFamilies.has(family) ? family : 'other'
}

export function isBashTimeout(part: WorkflowToolPart, family: string): boolean {
  return (
    part.timedOut === true ||
    part.exit === 124 ||
    (family === 'curl' && part.exit === 28) ||
    [part.error, part.outputTail, part.metaOutputTail].some((value) =>
      /(?:bash|shell) tool terminated command after exceeding timeout|command timed out|execution timed out|command failed because it timed out/i.test(
        value ?? '',
      ),
    )
  )
}

export function normalizeErrorSignature(error: string): string {
  return error
    .replace(/https?:\/\/[^\s"'<>),;]+/gi, '<URL>')
    .replace(/(?<!\w)(?:[A-Za-z]:\\|\/|~\/)[^\s"'<>),;]+/g, '<PATH>')
    .replace(/\b(?:ses|msg|prt|call)_[A-Za-z0-9_-]+\b|\b[0-9a-f]{8,}\b/gi, '<ID>')
    .replace(/\d+/g, '<N>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120)
}

export function redactInputPreview(inputHead: string): string {
  return inputHead
    .slice(0, 140)
    .replace(/bearer\s+\S+/gi, '<REDACTED>')
    .replace(/basic\s+[A-Za-z0-9+/=]{8,}/gi, '<REDACTED>')
    .replace(
      /["']?(token|secret|password|passwd|api[_-]?key|access[_-]?key|client[_-]?secret|authorization)["']?\s*[:=]\s*("[^"]*"?|'[^']*'?|\S+)/gi,
      '<REDACTED>',
    )
    .replace(/--(token|password|api-key|secret)[=\s]+\S+/gi, '<REDACTED>')
    .replace(/\b(sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{20,})/gi, '<REDACTED>')
    .slice(0, 140)
}

const mcpPrefixes = [
  'context7_',
  'firecrawl_',
  'playwright_',
  'ref_',
  'codegraph_',
  'lsp_',
  'websearch_',
  'grep_app_',
  'markitdown_',
  'session_',
] as const

export function getMcpPrefix(tool: string): string | undefined {
  return tool === 'skill_mcp' || tool === 'ocm' ? tool : mcpPrefixes.find((prefix) => tool.startsWith(prefix))
}

export function getSessionKind(session: WorkflowSession | undefined): 'scheduled' | 'subagent' | 'interactive' {
  if (session?.title.startsWith('Scheduled:')) return 'scheduled'
  return session?.parentId ? 'subagent' : 'interactive'
}
