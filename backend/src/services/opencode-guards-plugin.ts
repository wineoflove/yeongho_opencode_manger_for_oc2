type GuardsPluginOptions = {
  readonly id: string
  readonly verifyOutputDir: string
  readonly switchFile: string
}

/**
 * Builds the managed guards plugin: G1 rejects writes that contain Headroom compression markers,
 * G3 adapts browser tool calls the Playwright MCP cannot run, and G4 summarizes long verification
 * shell output for the model while keeping the full text in a private log.
 */
export function buildGuardsPluginSource({ id, verifyOutputDir, switchFile }: GuardsPluginOptions): string {
  return String.raw`import { mkdir, readFile, readdir, lstat, unlink, writeFile } from 'node:fs/promises'
import { basename, isAbsolute, join, relative, sep } from 'node:path'

const verifyOutputDir = ${JSON.stringify(verifyOutputDir)}
const switchFile = ${JSON.stringify(switchFile)}
const GUARD_IDS = ['G1', 'G3', 'G4']
const SUMMARY_THRESHOLD = 6000
const SUMMARY_LIMIT = 2500

function writeTexts(tool, input) {
  if (input === null || typeof input !== 'object') return []
  switch (tool) {
    case 'write': return [input.content]
    case 'edit': return [input.newString]
    case 'patch': return [input.patchText]
    case 'ocm': return input.action === 'request' && ['PUT', 'PATCH', 'POST'].includes(input.params?.method) ? [JSON.stringify(input.params.body)] : []
    default: return []
  }
}

function isVerificationCommand(command) {
  if (typeof command !== 'string') return false
  const tokens = command.match(/(?:[^\s'";&|\\]|\\[\s\S]|"(?:\\[\s\S]|[^"\\])*"|'[^']*')+|&&|[;&|]/g) ?? []
  let offset = 0
  while (offset < tokens.length) {
    if (tokens[offset] === 'export') {
      const end = tokens.findIndex((token, index) => index > offset && (token === ';' || token === '&&'))
      if (end === -1) return false
      offset = end + 1
    } else if (tokens[offset] === 'cd' && tokens[offset + 2] === '&&') {
      offset += 3
    } else if (tokens[offset] === 'env' || /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[offset])) {
      offset += 1
    } else {
      break
    }
  }
  const words = tokens.slice(offset).map(token => token.replace(/['"]/g, '').replace(/\s/g, '_'))
  if (!words.length) return false
  words[0] = basename(words[0])
  const normalized = words.join(' ')
  return /^(?:npx\s+|bunx\s+)?(?:tsc|vitest|jest|eslint|biome|oxlint|pytest|playwright\s+test)\b/.test(normalized)
    || /^(?:bun|pnpm|npm|yarn)\s+(?:(?:--dir|-C|--filter|--prefix)\s+\S+\s+)*(?:exec\s+|run\s+)?(?:test|test:run|test:bun|test:vitest|typecheck|lint|build|check|tsc|vitest|eslint|jest)\b/.test(normalized)
    || /^bun\s+(?:--no-env-file\s+)?test\b/.test(normalized)
    || /^node\s+--test\b/.test(normalized)
    || /^(?:cargo|go)\s+(?:test|build|vet|clippy)\b/.test(normalized)
}

function summarize(original, savedPath, exit) {
  const lines = original.split(/\r?\n/).filter(line => line.trim().length > 0)
  const failures = [...new Set(lines.filter(line => /(error|fail|failed|✗|×|panic|exception|TS\d{4}|AssertionError|expected)/i.test(line)))]
  const selected = failures.slice(0, 40).map(line => line.slice(0, 200))
  const last = lines.slice(-15).map(line => line.slice(0, 120))
  const truncation = /\[showing lines (\d+)-(\d+) of (\d+); full output saved to ([^\]\s]+)\]/.exec(original)
  const untruncated = truncation
    ? ['OpenCode kept lines ' + truncation[1] + '-' + truncation[2] + ' of ' + truncation[3] + '; untruncated output: ' + truncation[4]]
    : []
  const render = () => [
    '[OCM_GUARD_G4] Verification output summarized (' + original.length + ' chars). Full output: ' + savedPath,
    ...untruncated,
    'exit: ' + (exit ?? 'unknown'),
    '--- failure-related lines (' + selected.length + ' of ' + failures.length + ') ---',
    ...selected,
    '--- last 15 lines ---',
    ...last,
  ].join('\n')
  while (render().length > SUMMARY_LIMIT && selected.length) selected.pop()
  while (render().length > SUMMARY_LIMIT && last.length) last.shift()
  return render().slice(0, SUMMARY_LIMIT)
}

function shellBody(result) {
  if (typeof result.output?.output === 'string') return result.output.output
  if (typeof result.content === 'string') return result.content
  if (Array.isArray(result.content) && result.content[0]?.type === 'text') return result.content[0].text
  return null
}

function shellNotices(result) {
  if (!Array.isArray(result.content)) return []
  return result.content.slice(1).filter(item => item?.type === 'text')
}

function appendNote(result, note) {
  if (Array.isArray(result.content)) {
    result.content = [...result.content, { type: 'text', text: note }]
  } else if (typeof result.content === 'string') {
    result.content = result.content + '\n' + note
  } else {
    result.content = [{ type: 'text', text: note }]
  }
}

async function removeExpiredLogs() {
  const entries = await readdir(verifyOutputDir, { withFileTypes: true }).catch(() => [])
  await Promise.all(entries.filter(entry => entry.isFile() && entry.name.endsWith('.log')).map(async entry => {
    try {
      const file = join(verifyOutputDir, entry.name)
      const info = await lstat(file)
      if (info.isFile() && Date.now() - info.mtimeMs > 7 * 86400000) await unlink(file)
    } catch {
      return
    }
  }))
}

export default {
  id: ${JSON.stringify(id)},
  async setup(ctx) {
    const directory = ctx.location.directory
    const screenshots = new Map()
    let disabled = []
    let checkedAt = -Infinity

    async function switches() {
      const now = Date.now()
      if (now - checkedAt < 30000) return disabled
      checkedAt = now
      try {
        const parsed = JSON.parse(await readFile(switchFile, 'utf8'))
        disabled = Array.isArray(parsed?.disabled) && parsed.disabled.every(guard => GUARD_IDS.includes(guard)) ? parsed.disabled : []
      } catch {
        disabled = []
      }
      return disabled
    }

    await removeExpiredLogs()

    await ctx.tool.hook('execute.before', async (event) => {
      const off = await switches()
      const input = event.input
      if (!off.includes('G1')) {
        for (const text of writeTexts(event.tool, input)) {
          const match = typeof text === 'string' && text.match(/Retrieve (?:more|original): hash=[a-f0-9]{12,}|<<ccr:[^>\s]{6,}>>/)
          if (match) throw new Error('OCM_GUARD_G1_COMPRESSED_CONTENT: the content contains a Headroom compression marker (' + match[0] + '). It is a summary, not the original. Re-read the source from disk or call headroom_retrieve with that hash, then write the real content.')
        }
      }
      if (off.includes('G3') || input === null || typeof input !== 'object') return
      if (event.tool === 'playwright_browser_run_code_unsafe' && typeof input.code === 'string' && /\brequire\s*\(|\bimport\s*\(/.test(input.code)) {
        throw new Error('OCM_GUARD_G3_RUN_CODE_UNSUPPORTED: browser_run_code_unsafe runs in a VM without require() or dynamic import(). Use page APIs and plain JavaScript only.')
      }
      if (event.tool === 'playwright_browser_take_screenshot' && typeof input.filename === 'string' && isAbsolute(input.filename)) {
        const path = relative(directory, input.filename)
        if (path === '..' || path.startsWith('..' + sep) || isAbsolute(path)) {
          screenshots.set(event.id, input.filename)
          delete input.filename
        }
      }
    })

    await ctx.tool.hook('execute.after', async (event) => {
      if (event.tool === 'playwright_browser_take_screenshot' && screenshots.has(event.id)) {
        const original = screenshots.get(event.id)
        screenshots.delete(event.id)
        if (event.status === 'completed') {
          event.result.metadata = { ...(event.result.metadata ?? {}), ocmGuard: { id: 'G3', action: 'filename_removed', original } }
          appendNote(event.result, '[OCM_GUARD_G3] filename "' + original + '" was outside the browser\'s allowed roots, so it was removed and the screenshot was saved to the default output directory shown above.')
        }
        return
      }
      if (event.tool !== 'shell' || event.status !== 'completed' || !isVerificationCommand(event.input?.command)) return
      if ((await switches()).includes('G4')) return
      const body = shellBody(event.result)
      if (typeof body !== 'string' || body.length <= SUMMARY_THRESHOLD) return
      const savedPath = join(verifyOutputDir, encodeURIComponent(event.sessionID) + '_' + encodeURIComponent(event.id) + '.log')
      try {
        await mkdir(verifyOutputDir, { recursive: true })
        await writeFile(savedPath, body, { mode: 0o600 })
      } catch {
        return
      }
      const exit = event.result.output?.exit ?? event.result.metadata?.exit
      event.result.content = [{ type: 'text', text: summarize(body, savedPath, exit) }, ...shellNotices(event.result)]
      event.result.metadata = { ...(event.result.metadata ?? {}), ocmGuard: { id: 'G4', originalChars: body.length, savedPath } }
    })
  },
}
`
}
