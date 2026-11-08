import { promises as fs } from 'fs'
import { join } from 'path'
import { writeFileAtomic } from '../../utils/fs-safe'
import { buildGhEnvPluginSource } from '../opencode-gh-env-plugin'
import { buildGuardsPluginSource } from '../opencode-guards-plugin'
import { buildManagerToolPluginSource } from '../opencode-manager-tool-plugin'
import { buildSandboxPluginSource } from '../opencode-sandbox-plugin'
import { getOpenCodeServiceSettingsPath } from '../opencode-service-mode'
import { ensureSandboxShellShim } from '../sandbox/shell-shim'

const MANAGED_OPENCODE_PLUGIN_IDS = {
  ghEnv: 'ocm.gh-env',
  guards: 'ocm.guards',
  manager: 'ocm.manager',
  sandbox: 'ocm.sandbox',
} as const

type ManagedOpenCodePlugin = {
  id: string
  filename: string
  buildSource: (context: { id: string; configHome: string; shellShimPath: string; serviceSettingsPath: string }) => string
}

const MANAGED_OPENCODE_PLUGINS: readonly ManagedOpenCodePlugin[] = [
  {
    id: MANAGED_OPENCODE_PLUGIN_IDS.ghEnv,
    filename: 'ocm-gh-env.js',
    buildSource: ({ id }) => buildGhEnvPluginSource(id),
  },
  {
    id: MANAGED_OPENCODE_PLUGIN_IDS.guards,
    filename: 'ocm-guards.js',
    buildSource: ({ id, configHome }) =>
      buildGuardsPluginSource({
        id,
        verifyOutputDir: getGuardsVerifyOutputDir(configHome),
        switchFile: getGuardsSwitchFile(configHome),
      }),
  },
  {
    id: MANAGED_OPENCODE_PLUGIN_IDS.manager,
    filename: 'ocm-manager.js',
    buildSource: ({ id }) => buildManagerToolPluginSource(id),
  },
  {
    id: MANAGED_OPENCODE_PLUGIN_IDS.sandbox,
    filename: 'ocm-sandbox.js',
    buildSource: ({ id, shellShimPath, serviceSettingsPath }) => buildSandboxPluginSource(id, shellShimPath, serviceSettingsPath),
  },
]

export function getOpenCodePluginDir(configHome: string): string {
  return join(configHome, 'opencode', 'plugins')
}

/** Directory where the guards plugin keeps full verification output it summarized for the model. */
export function getGuardsVerifyOutputDir(configHome: string): string {
  return join(configHome, '..', '.opencode', 'state', 'opencode', 'tool-output', 'ocm-verify')
}

/** JSON file whose `disabled` array turns individual guards (G1, G3, G4) off without a restart. */
export function getGuardsSwitchFile(configHome: string): string {
  return join(configHome, 'opencode', 'ocm-guards.json')
}

export async function installManagedPlugins(configHome: string): Promise<void> {
  const shellShimPath = await ensureSandboxShellShim(configHome)
  const serviceSettingsPath = getOpenCodeServiceSettingsPath()
  const dir = getOpenCodePluginDir(configHome)
  const legacyDir = join(configHome, 'opencode', 'plugin')
  for (const plugin of MANAGED_OPENCODE_PLUGINS) {
    await writeFileAtomic(join(dir, plugin.filename), plugin.buildSource({ id: plugin.id, configHome, shellShimPath, serviceSettingsPath }))
    await fs.rm(join(legacyDir, plugin.filename), { force: true })
  }
}
