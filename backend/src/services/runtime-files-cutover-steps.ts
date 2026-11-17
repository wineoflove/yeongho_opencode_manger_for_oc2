import { lstat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { configurationCutoverSteps } from './cutover-config-steps'
import { newPluginCutoverStep } from './cutover-plugin-step'
import { newDirectoryCutoverStep } from './cutover-directory-step'
import { launchdDefinitionSteps } from './launchd-definition-persist'
import { transitionLegacyPlugins, LegacyPluginTransitionError } from './legacy-plugin-transition'
import { pluginIdentity } from './legacy-plugin-files'
import type { CutoverStep } from './cutover-step-runner'

export function runtimeFilesCutoverSteps(input: {
  readonly assertForwardReady: () => Promise<void>
  readonly configurations: Parameters<typeof configurationCutoverSteps>[0]
  readonly legacyPlugins: Parameters<typeof transitionLegacyPlugins>[0]
  readonly modelPlugin: Parameters<typeof newPluginCutoverStep>[0]
  readonly modelPluginDirectory?: Parameters<typeof newDirectoryCutoverStep>[0]
  readonly definitions: Parameters<typeof launchdDefinitionSteps>[0]
}): readonly CutoverStep[] {
  if (input.modelPluginDirectory && input.modelPluginDirectory.target !== dirname(input.modelPlugin.target))
    throw new LegacyPluginTransitionError('INVALID_SCOPE')
  return [
    {
      name: 'validate-file-preconditions',
      forward: input.assertForwardReady,
      rollback: async () => {},
    },
    ...configurationCutoverSteps(input.configurations),
    {
      name: 'archive-v1-plugins',
      forward: async () => {
        await transitionLegacyPlugins(input.legacyPlugins, 'archive')
      },
      rollback: async () => {
        await input.legacyPlugins.assertQuiescent()
        try {
          await lstat(join(input.legacyPlugins.archiveDirectory, 'manifest.json'))
        } catch (error) {
          if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
          for (const entry of input.legacyPlugins.entries)
            if (!(await pluginIdentity(join(input.legacyPlugins.sourceDirectory, entry.name), entry.sha256)))
              throw new LegacyPluginTransitionError('MISSING_ORIGINAL')
          return
        }
        await transitionLegacyPlugins(input.legacyPlugins, 'restore')
      },
    },
    ...(input.modelPluginDirectory ? [newDirectoryCutoverStep(input.modelPluginDirectory)] : []),
    newPluginCutoverStep(input.modelPlugin),
    ...launchdDefinitionSteps(input.definitions),
  ]
}
