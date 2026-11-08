import { auth } from './auth'
import { common } from './common'
import { errors } from './errors'
import { messages } from './messages'
import { misc } from './misc'
import { navigation } from './navigation'
import { repos } from './repos'
import { schedules } from './schedules'
import { sessions } from './sessions'
import { settings } from './settings'
import { settingsIntegrations } from './settings-integrations'
import { stats } from './stats'
import { system } from './system'

export type CatalogFiles = Readonly<Record<string, Readonly<Record<string, string>>>>

export interface ConflictingKey {
  readonly key: string
  readonly values: Readonly<Record<string, string>>
}

const KO_FILES: CatalogFiles = {
  common,
  errors,
  navigation,
  auth,
  sessions,
  repos,
  schedules,
  settings,
  'settings-integrations': settingsIntegrations,
  stats,
  system,
  messages,
  misc,
}

export const KO: Record<string, string> = Object.assign({}, ...Object.values(KO_FILES))

export function findConflictingKeys(files: CatalogFiles = KO_FILES): ConflictingKey[] {
  const byKey = new Map<string, Record<string, string>>()
  for (const [file, entries] of Object.entries(files)) {
    for (const [key, value] of Object.entries(entries)) {
      byKey.set(key, { ...byKey.get(key), [file]: value })
    }
  }
  return [...byKey.entries()]
    .filter(([, values]) => new Set(Object.values(values)).size > 1)
    .map(([key, values]) => ({ key, values }))
}
