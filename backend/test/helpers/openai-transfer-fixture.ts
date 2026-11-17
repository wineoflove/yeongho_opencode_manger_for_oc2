import { createCipheriv, randomBytes, scryptSync } from 'node:crypto'
import { mkdtemp, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const passphrase = 'synthetic-passphrase'

export async function createOpenAiTransferFixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'openai-transfer-')))
  const sourceFile = join(root, 'accounts.json')
  const account = (alias: string) => ({
    accountId: `synthetic-${alias}`,
    accessToken: `synthetic-access-${alias}`,
    refreshToken: `synthetic-refresh-${alias}`,
    expiresAt: Date.now() + 7200000,
    planType: 'pro',
    usageCount: 1,
  })
  const source = {
    version: 2,
    activeAlias: 'first',
    rotationIndex: 1,
    accounts: { first: account('first'), second: account('second') },
  }
  const salt = randomBytes(16)
  const iv = randomBytes(12)
  const key = scryptSync(passphrase, salt, 32)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(source)), cipher.final()])
  key.fill(0)
  const encrypted = JSON.stringify({
    version: 2,
    encrypted: true,
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: ciphertext.toString('base64'),
  })
  await writeFile(sourceFile, encrypted, { mode: 0o600 })
  return {
    root,
    source,
    encrypted,
    input: {
      sourceFile,
      directory: join(root, 'staged'),
      passphrase,
      executionBudgetMs: 60000,
      assertQuiescent: async () => {},
    },
  }
}
