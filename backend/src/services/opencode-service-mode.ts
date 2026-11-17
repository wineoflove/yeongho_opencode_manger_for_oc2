import path from 'path'
import { promises as fs } from 'fs'
import { getConfigPath, getOpenCodeDataPath } from '@opencode-manager/shared/config/env'
import { writeFileAtomic } from '../utils/fs-safe'

const OPENCODE_APP_DIRECTORY = 'opencode'
function serviceFilename(): string {
  const channel = process.env.OPENCODE_SERVICE_CHANNEL ?? 'latest'
  if (!/^[A-Za-z0-9._-]+$/.test(channel)) throw new Error('Invalid OpenCode service channel')
  return ['latest', 'dev', 'beta', 'next'].includes(channel) ? 'service.json' : `service-${channel}.json`
}

const SHARED_DATABASE_CHANNELS = ['latest', 'dev', 'beta', 'next', 'prod']

/** Mirrors OpenCode's database file selection so Manager reads the database its service channel writes. */
export function getOpenCodeDatabasePath(
  env: Readonly<Record<string, string | undefined>> = process.env,
  dataPath: string = getOpenCodeDataPath(),
): string {
  const channel = env.OPENCODE_SERVICE_CHANNEL ?? 'latest'
  const shared =
    SHARED_DATABASE_CHANNELS.includes(channel) || ['1', 'true'].includes(env.OPENCODE_DISABLE_CHANNEL_DB ?? '')
  const filename = env.OPENCODE_DB ?? (shared ? 'opencode.db' : `opencode-${channel.replace(/[^a-zA-Z0-9._-]/g, '-')}.db`)
  return path.resolve(dataPath, filename)
}

export const OPENCODE_SERVICE_SERVE_ARGS = ['serve', '--service'] as const

export type OpenCodeServiceEnv = {
  XDG_CONFIG_HOME: string
  XDG_STATE_HOME: string
}

export function getOpenCodeServiceSettingsPath(): string {
  return path.join(getConfigPath(), serviceFilename())
}

export function getOpenCodeServiceRegistrationPath(env: OpenCodeServiceEnv): string {
  return path.join(env.XDG_STATE_HOME, OPENCODE_APP_DIRECTORY, serviceFilename())
}

export async function writeOpenCodeServiceSettings(configDirectory: string, password: string): Promise<void> {
  await writeFileAtomic(path.join(configDirectory, serviceFilename()), `${JSON.stringify({ password }, null, 2)}\n`, {
    mode: 0o600,
  })
}

export async function prepareOpenCodeServiceLaunch(env: OpenCodeServiceEnv, password: string): Promise<void> {
  await fs.rm(getOpenCodeServiceRegistrationPath(env), { force: true })
  await writeOpenCodeServiceSettings(getConfigPath(), password)
}
