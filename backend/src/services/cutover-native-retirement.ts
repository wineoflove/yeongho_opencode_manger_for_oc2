import { retireNativeDatabase } from './native-database-install'

export async function retireNativeAfterCredentialReturn(input: {
  readonly retirement: Parameters<typeof retireNativeDatabase>[0]
  readonly returnCredentials: () => Promise<void>
}) {
  await input.retirement.assertQuiescent()
  await input.returnCredentials()
  await input.retirement.assertQuiescent()
  return retireNativeDatabase(input.retirement)
}
