import { coreEnforced } from './core'
import { i18nEnforced } from './i18n'
import { messagesEnforced } from './messages'
import { navigationEnforced } from './navigation'
import { pagesEnforced } from './pages'
import { reposEnforced } from './repos'
import { schedulesEnforced } from './schedules'
import { sessionsEnforced } from './sessions'
import { settingsEnforced } from './settings'
import { shellEnforced } from './shell'
import { systemEnforced } from './system'

export const ENFORCED_AREAS: Readonly<Record<string, readonly string[]>> = {
  i18n: i18nEnforced,
  shell: shellEnforced,
  core: coreEnforced,
  navigation: navigationEnforced,
  pages: pagesEnforced,
  sessions: sessionsEnforced,
  messages: messagesEnforced,
  repos: reposEnforced,
  schedules: schedulesEnforced,
  settings: settingsEnforced,
  system: systemEnforced,
}
