import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { isDeepStrictEqual } from 'node:util'

class CliError extends Error {
  constructor(error, exitCode = 1, field) {
    super(error)
    this.exitCode = exitCode
    this.output = { error, ...(field ? { field } : {}) }
  }
}

function parseArgs(args) {
  const [command, ...rest] = args
  if (command === '--help' && rest.length === 0) return { command }
  const allowed =
    command === 'snapshot'
      ? ['out']
      : command === 'patch'
        ? ['repo', 'job', 'enabled', 'cron', 'timezone', 'allow-external-directory', 'append-prompt-file', 'dry-run']
        : []
  if (!allowed.length) throw new CliError('INVALID_ARGUMENTS', 2)
  const options = {}
  for (let index = 0; index < rest.length; index++) {
    const argument = rest[index]
    const name = argument.slice(2)
    if (!argument.startsWith('--') || !allowed.includes(name) || Object.hasOwn(options, name)) {
      throw new CliError('INVALID_ARGUMENTS', 2)
    }
    if (name === 'dry-run') {
      options[name] = true
    } else {
      const value = rest[++index]
      if (!value?.trim() || value.startsWith('--')) throw new CliError('INVALID_ARGUMENTS', 2)
      options[name] = value
    }
  }
  if (command === 'patch') {
    for (const name of ['repo', 'job']) {
      const pattern = name === 'repo' ? /^(0|[1-9][0-9]*)$/ : /^[1-9][0-9]*$/
      if (!pattern.test(options[name] ?? '') || !Number.isSafeInteger(Number(options[name]))) {
        throw new CliError('INVALID_ARGUMENTS', 2)
      }
    }
    for (const name of ['enabled', 'allow-external-directory']) {
      if (Object.hasOwn(options, name) && !['true', 'false'].includes(options[name])) {
        throw new CliError('INVALID_ARGUMENTS', 2)
      }
    }
  }
  return { command, options }
}

function promptSummary(prompt) {
  return { promptSha256: createHash('sha256').update(prompt).digest('hex'), promptLength: prompt.length }
}

function summarizeFields(job, fields) {
  return {
    ...Object.fromEntries(fields.filter((field) => field !== 'prompt').map((field) => [field, job[field]])),
    ...promptSummary(job.prompt),
  }
}

function print(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`)
}

async function main() {
  if (!process.env.OCM_INTERNAL_API_URL || !process.env.OCM_INTERNAL_TOKEN) {
    throw new CliError('INTERNAL_API_NOT_CONFIGURED', 2)
  }
  const { command, options } = parseArgs(process.argv.slice(2))
  if (command === '--help') {
    process.stdout.write(
      'Usage: patch-job.mjs snapshot [--out <file>]\n       patch-job.mjs patch --repo <id> --job <id> [--enabled true|false] [--cron <expr>] [--timezone <tz>] [--allow-external-directory true|false] [--append-prompt-file <path>] [--dry-run]\n',
    )
    return
  }
  async function request(path, body) {
    let response
    try {
      response = await fetch(process.env.OCM_INTERNAL_API_URL.replace(/\/$/, '') + path, {
        method: body ? 'PATCH' : 'GET',
        headers: {
          Authorization: `Bearer ${process.env.OCM_INTERNAL_TOKEN}`,
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        redirect: 'error',
      })
    } catch {
      throw new CliError('REQUEST_FAILED')
    }
    if (!response.ok) throw new CliError(`HTTP_${response.status}`)
    if (body) return
    try {
      return await response.json()
    } catch {
      throw new CliError('INVALID_RESPONSE')
    }
  }
  if (command === 'snapshot') {
    const { jobs } = await request('/schedules/all')
    const output = jobs.map(({ prompt, ...job }) => ({
      ...job,
      ...promptSummary(prompt),
      promptMarkers: prompt.match(/<!-- ocm-[a-z0-9-]+ -->/g) ?? [],
    }))
    if (options.out) {
      try {
        await writeFile(options.out, `${JSON.stringify(output, null, 2)}\n`, { mode: 0o600 })
      } catch {
        throw new CliError('OUTPUT_WRITE_FAILED')
      }
    } else print(output)
    return
  }
  const path = `/repos/${options.repo}/schedules/${options.job}`
  const { job: before } = await request(path)
  const body = {}
  function set(field, value) {
    if (!isDeepStrictEqual(before[field], value)) body[field] = value
  }
  if (Object.hasOwn(options, 'enabled')) set('enabled', options.enabled === 'true')
  if (options.cron) {
    set('scheduleMode', 'cron')
    set('cronExpression', options.cron)
    set('timezone', options.timezone ?? before.timezone)
  } else if (options.timezone) set('timezone', options.timezone)
  if (Object.hasOwn(options, 'allow-external-directory')) {
    if (before.permissionConfig === null) throw new CliError('PERMISSION_CONFIG_NULL')
    set('permissionConfig', {
      ...before.permissionConfig,
      allowExternalDirectory: options['allow-external-directory'] === 'true',
    })
  }
  if (options['append-prompt-file']) {
    let addition
    try {
      addition = await readFile(options['append-prompt-file'], 'utf8')
    } catch {
      throw new CliError('PROMPT_FILE_READ_FAILED')
    }
    const markers = addition.match(/^<!-- ocm-[a-z0-9-]+ -->[\t ]*\r?$/gm)?.map((marker) => marker.trim())
    if (!markers?.length) throw new CliError('PROMPT_MARKER_MISSING')
    if (!markers.some((marker) => before.prompt.includes(marker))) {
      const prompt = `${before.prompt.trimEnd()}\n\n${addition.trim()}`
      if (prompt.length > 20000) throw new CliError('PROMPT_TOO_LONG')
      set('prompt', prompt)
    }
  }
  const changed = Object.keys(body)
  if (!changed.length) {
    print({ changed })
    return
  }
  const summary = { changed, before: summarizeFields(before, changed) }
  if (options['dry-run']) {
    print({ ...summary, after: summarizeFields({ ...before, ...body }, changed) })
    return
  }
  await request(path, body)
  const { job: after } = await request(path)
  for (const field of changed) {
    const matches =
      field === 'prompt'
        ? promptSummary(after.prompt).promptSha256 === promptSummary(body.prompt).promptSha256
        : isDeepStrictEqual(after[field], body[field])
    if (!matches) throw new CliError('VERIFY_MISMATCH', 3, field)
  }
  const nextRunAtKst =
    after.nextRunAt === null
      ? null
      : new Date(after.nextRunAt + 9 * 60 * 60 * 1000).toISOString().replace(/\.\d{3}Z$/, '+09:00')
  print({
    jobId: after.id,
    ...summary,
    after: summarizeFields(after, changed),
    nextRunAt: after.nextRunAt,
    nextRunAtKst,
  })
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify(error instanceof CliError ? error.output : { error: 'OPERATION_FAILED' })}\n`)
  process.exitCode = error instanceof CliError ? error.exitCode : 1
})
