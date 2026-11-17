import { managerDatabaseCutoverStep } from './cutover-manager-database-step'
import { claudeActivationCutoverStep } from './cutover-claude-activation-step'
import { nativeDatabaseCutoverStep } from './cutover-native-database-step'
import { returnCutoverCredentials } from './cutover-credential-return'
import { assertOwnedNativeDatabase, checkpointOwnedNative } from './checkpoint-owned-native'
import type { CutoverStep } from './cutover-step-runner'
import { activateClaudeGatewayInStoppedCopy } from './claude-native-gateway'
import { z } from 'zod'
import { join } from 'node:path'
import { readPrivateTransferFile } from './claude-transfer-stage'

type ClaudeStepInput = Parameters<typeof claudeActivationCutoverStep>[0]
type NativeStepInput = Parameters<typeof nativeDatabaseCutoverStep>[0]
type CredentialReturnInput = Parameters<typeof returnCutoverCredentials>[0]

export function stoppedDataCutoverSteps(input: {
  readonly manager: Omit<Parameters<typeof managerDatabaseCutoverStep>[0], 'assertQuiescent'>
  readonly claude: Omit<ClaudeStepInput, 'staging'> & {
    readonly staging: Omit<ClaudeStepInput['staging'], 'assertQuiescent'>
  }
  readonly native: Omit<NativeStepInput, 'install' | 'returnCredentials'> & {
    readonly install: Omit<NativeStepInput['install'], 'assertQuiescent'>
    readonly root: string
  }
  readonly openai: {
    readonly copy: CredentialReturnInput['openai']['restore']['copy']
    readonly legacyTarget: string
    readonly passphrase: string
  }
  readonly assertQuiescent: () => Promise<void>
  readonly gateway: { readonly keyFile: string; readonly keySha256: string }
}): readonly CutoverStep[] {
  const claudeStep = claudeActivationCutoverStep({
    ...input.claude,
    staging: {
      ...input.claude.staging,
      assertQuiescent: input.assertQuiescent,
    },
  })
  const assertReturnReady = async () => {
    await input.assertQuiescent()
    await claudeStep.assertInstalledOwnership()
  }
  const claude = {
    ...input.claude.staging,
    targetAuthDirectory: input.claude.targetAuthDirectory,
    gateDirectory: input.claude.gateDirectory,
    assertQuiescent: assertReturnReady,
  }
  return [
    managerDatabaseCutoverStep({
      ...input.manager,
      assertQuiescent: input.assertQuiescent,
    }),
    claudeStep,
    nativeDatabaseCutoverStep({
      ...input.native,
      install: {
        ...input.native.install,
        assertQuiescent: input.assertQuiescent,
      },
      returnCredentials: async (owner) => {
        const assertReturnOwnerReady = async () => {
          await assertReturnReady()
          await assertOwnedNativeDatabase({
            database: input.native.install.target,
            owner,
          })
        }
        await assertReturnOwnerReady()
        const checkpoint = await checkpointOwnedNative({
          database: input.native.install.target,
          owner,
          stateDirectory: input.native.stateDirectory,
          assertQuiescent: assertReturnOwnerReady,
        })
        await returnCutoverCredentials({
          openai: {
            legacyTarget: input.openai.legacyTarget,
            restore: {
              copy: input.openai.copy,
              native: {
                root: input.native.root,
                database: input.native.install.target,
                sha256: checkpoint.sha256,
              },
              passphrase: input.openai.passphrase,
              assertQuiescent: assertReturnOwnerReady,
            },
          },
          claude: { ...claude, assertQuiescent: assertReturnOwnerReady },
        })
      },
    }),
    {
      name: 'activate-native-claude-gateway',
      forward: async () => {
        const owner = z
          .object({
            target: z.literal(input.native.install.target),
            device: z.number().int(),
            inode: z.number().int(),
          })
          .strict()
          .parse(JSON.parse(await readPrivateTransferFile(join(input.native.stateDirectory, 'native-installed.json'))))
        const assertGatewayReady = async () => {
          await assertReturnReady()
          await assertOwnedNativeDatabase({
            database: input.native.install.target,
            owner,
          })
        }
        await assertGatewayReady()
        await activateClaudeGatewayInStoppedCopy({
          root: input.native.root,
          database: input.native.install.target,
          sha256: input.native.install.stagedSha256,
          ...input.gateway,
          assertQuiescent: assertGatewayReady,
        })
      },
      rollback: async () => {},
    },
  ]
}
