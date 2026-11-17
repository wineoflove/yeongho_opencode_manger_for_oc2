import { z } from 'zod'
import { readOpenCodeConfigFile, withOpenCodeConfigLock } from './opencode-config-file'
import type { OpenCodeClient } from './opencode/client'
import { ProviderPoolStatusSchema } from '@opencode-manager/shared/schemas'

const poolReferences = z.object({
  providers: z
    .record(
      z.string(),
      z.object({
        settings: z
          .object({
            accountPool: z
              .object({
                accounts: z.array(z.object({ credentialID: z.string() })),
              })
              .optional(),
          })
          .optional(),
      }),
    )
    .optional(),
})

async function checkPoolRemoval(credentialIDs: readonly string[], client: OpenCodeClient) {
  const config = await readOpenCodeConfigFile()
  if (config && !config.isValid) return 'unavailable' as const
  const parsed = poolReferences.safeParse(config?.content ?? {})
  if (!parsed.success) return 'unavailable' as const
  const referenced = Object.values(parsed.data.providers ?? {}).some((provider) =>
    provider.settings?.accountPool?.accounts.some((account) => credentialIDs.includes(account.credentialID)),
  )
  if (referenced) return 'referenced' as const
  const response = await client.forwardRaw(new Request('http://opencode.local/api/provider'))
  if (!response.ok) return 'unavailable' as const
  const providers = z.object({ data: z.array(z.object({ id: z.string() })) }).safeParse(await response.json())
  if (!providers.success) return 'unavailable' as const
  for (const provider of providers.data.data) {
    const status = await client.forwardRaw(
      new Request(`http://opencode.local/api/provider/${encodeURIComponent(provider.id)}/pool`),
    )
    if (status.status === 404) continue
    if (!status.ok) return 'unavailable' as const
    const pool = z.object({ data: ProviderPoolStatusSchema }).safeParse(await status.json())
    if (!pool.success) return 'unavailable' as const
    if (pool.data.data.accounts.some((account) => credentialIDs.includes(account.credentialID)))
      return 'referenced' as const
  }
  return 'allowed' as const
}

export async function removePoolAccounts(credentialIDs: readonly string[], client: OpenCodeClient) {
  return withOpenCodeConfigLock(async () => {
    const state = await checkPoolRemoval(credentialIDs, client)
    if (state !== 'allowed') return state
    for (const credentialID of credentialIDs) await client.api.credential.remove({ credentialID })
    return 'allowed' as const
  })
}
