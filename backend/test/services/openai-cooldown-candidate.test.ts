import { createHash } from 'node:crypto'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createOpenAiTransferFixture, passphrase } from '../helpers/openai-transfer-fixture'
import { encodeLegacyOpenAiStore } from '../../src/services/legacy-openai-store'
import { stageOpenAiTransfer } from '../../src/services/openai-transfer-stage'
import { validateOpenAiTransferCandidate } from '../../src/services/openai-transfer-candidate'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
async function fixture() {
  const value = await createOpenAiTransferFixture()
  roots.push(value.root)
  const until = Date.now() + 3600000
  const source = {
    ...value.source,
    accounts: {
      ...value.source.accounts,
      first: { ...value.source.accounts.first, rateLimitedUntil: until },
    },
  }
  const original = encodeLegacyOpenAiStore(source, passphrase)
  await writeFile(value.input.sourceFile, original)
  return {
    input: { ...value.input, preserveRateLimits: true },
    original,
    until,
  }
}
describe('cooldown-preserving stage policy binding', () => {
  it('stores the explicit policy and reconstructs the original restriction during validation', async () => {
    const { input, original, until } = await fixture()
    const ledger = await stageOpenAiTransfer(input)
    expect(ledger.preserveRateLimits).toBe(true)
    const validated = await validateOpenAiTransferCandidate(input)
    expect(validated.rotation.accountStates).toHaveLength(1)
    expect(validated.rotation.accountStates?.[0]?.value.cooldownUntil).toBe(until)
    expect(await readFile(input.sourceFile, 'utf8')).toBe(original)
  })
  it('rejects changing an existing cooldown policy to the default on resume', async () => {
    const { input } = await fixture()
    await stageOpenAiTransfer(input)
    await expect(validateOpenAiTransferCandidate({ ...input, preserveRateLimits: false })).rejects.toMatchObject({
      code: 'INVALID_STAGE',
    })
  })
  it('rejects enabling the policy on a stage prepared without it', async () => {
    const value = await createOpenAiTransferFixture()
    roots.push(value.root)
    await stageOpenAiTransfer(value.input)
    await expect(
      validateOpenAiTransferCandidate({
        ...value.input,
        preserveRateLimits: true,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_STAGE' })
  })
  it('rejects shortened cooldown even when the modified candidate hash matches its ledger', async () => {
    const { input } = await fixture()
    await stageOpenAiTransfer(input)
    const rotationPath = join(input.directory, 'rotation.pending.json')
    const ledgerPath = join(input.directory, 'ledger.json')
    const rotation = JSON.parse(await readFile(rotationPath, 'utf8'))
    rotation.accountStates[0].value.cooldownUntil = 0
    const text = JSON.stringify(rotation)
    const ledger = JSON.parse(await readFile(ledgerPath, 'utf8'))
    ledger.rotationFileSha256 = createHash('sha256').update(text).digest('hex')
    await writeFile(rotationPath, text)
    await writeFile(ledgerPath, JSON.stringify(ledger))
    await expect(validateOpenAiTransferCandidate(input)).rejects.toMatchObject({
      code: 'CANDIDATE_CHANGED',
    })
  })
})
