import { execFileSync } from 'node:child_process'
import { realpath } from 'node:fs/promises'
import { userInfo } from 'node:os'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { inside } from './application-files.mjs'

// Manager runs with an isolated HOME, and Bun's userInfo() follows HOME, so read the
// account's home from macOS directory services instead.
export function accountHome() {
  try {
    const user = execFileSync('/usr/bin/id', ['-un'], { encoding: 'utf8', timeout: 5000 }).trim()
    const record = execFileSync('/usr/bin/dscl', ['.', '-read', `/Users/${user}`, 'NFSHomeDirectory'], {
      encoding: 'utf8',
      timeout: 5000,
    })
    const home = /^NFSHomeDirectory:\s*(\S.*?)\s*$/m.exec(record)?.[1]
    if (home && isAbsolute(home)) return home
  } catch {
    // Not macOS or no directory record: fall back below.
  }
  return userInfo().homedir
}

export const userBinDirectory = join(accountHome(), '.local/bin')

const installed = {
  bun: join(userBinDirectory, 'bun'),
  node: '/opt/homebrew/bin/node',
  pnpm: join(userBinDirectory, 'pnpm'),
  python3: '/usr/bin/python3',
  ruff: join(userBinDirectory, 'ruff'),
}
const localTools = ['tsc', 'vitest', 'eslint', 'prettier']
const rejected = () => {
  throw new Error('CHECK_COMMAND_NOT_ALLOWED')
}

export async function resolveVerificationCommand(config, input, cwd) {
  const name = basename(input.argv[0])
  if (
    input.argv.some(
      (arg) =>
        /[\x00\n\r]/.test(arg) ||
        /^(?:install|add|remove|update|upgrade|deploy|restart|start|dev|publish|execpath|pip|sync|lock|--fix|--write|--unsafe-fixes)(?:=|$)/.test(
          arg,
        ),
    )
  )
    rejected()
  if (
    ['node', 'bun'].includes(name) &&
    input.argv.some((arg) => /^(?:--eval|--print|--require|--import|--preload)(?:=|$)|^-[epr]/.test(arg))
  )
    rejected()
  if (name === 'python3' && input.argv.some((arg) => /^-c/.test(arg))) rejected()
  const kindMarker = {
    test: /^(test(?::[\w-]+)?|vitest)$/,
    typecheck: /^(typecheck(?::[\w-]+)?|tsc)$/,
    lint: /^(lint(?::[\w-]+)?|eslint|prettier|ruff)$/,
    build: /^build(?::[\w-]+)?$/,
  }
  const args = input.argv.slice(1)
  if (input.kind === 'runtime') {
    if (!['node', 'bun'].includes(name) || args.length !== 2 || args[1] !== '--check' || args[0].startsWith('-'))
      rejected()
    const script = await realpath(isAbsolute(args[0]) ? args[0] : join(cwd, args[0]))
    if (!inside(cwd, script)) rejected()
  } else if (name === 'node') {
    if (input.kind !== 'test' || args[0] !== '--test') rejected()
  } else if (name === 'bun' || name === 'pnpm') {
    const offset = args[0] === '--no-env-file' && name === 'bun' ? 1 : 0
    const first = args[offset]
    const command = first === 'run' || first === 'exec' ? args[offset + 1] : first
    if (!kindMarker[input.kind]?.test(command ?? '')) rejected()
  } else if (name === 'python3') {
    const module = args.indexOf('-m')
    if (
      input.kind !== 'test' ||
      module < 0 ||
      !['unittest', 'pytest'].includes(args[module + 1]) ||
      args.slice(0, module).some((arg) => !['-I', '-B'].includes(arg))
    )
      rejected()
  } else if (name === 'ruff') {
    if (input.kind !== 'lint' || args[0] !== 'check') rejected()
  } else if (!localTools.includes(name) || !kindMarker[input.kind]?.test(name)) rejected()
  let path = installed[name]
  if (!path && localTools.includes(name)) {
    let directory = cwd
    while (config.codeRoots.some((root) => inside(root, directory))) {
      try {
        path = await realpath(join(directory, 'node_modules/.bin', name))
        break
      } catch (error) {
        if (!(error instanceof Error && error.code === 'ENOENT')) throw error
      }
      const parent = dirname(directory)
      if (parent === directory) break
      directory = parent
    }
  }
  if (!path) rejected()
  const canonical = await realpath(path)
  if (input.argv[0] !== name && (!isAbsolute(input.argv[0]) || (await realpath(input.argv[0])) !== canonical))
    rejected()
  return canonical
}
