import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { resolveOpenCode2Binary } from '../helpers/opencode-binary'
import { createOAuthAccountsFixture } from '../fixtures/provider-oauth-accounts'

const binary = resolveOpenCode2Binary()
if (process.env.OPENCODE_BIN && binary !== process.env.OPENCODE_BIN) {
  throw new Error('OPENCODE_BIN must resolve to a supported executable for this integration test')
}

const AccountSchema = z
  .object({
    id: z.string(),
    integrationID: z.literal('fixture-auth'),
    label: z.string(),
    active: z.boolean(),
    type: z.literal('oauth'),
    methodID: z.literal('fixture-code'),
  })
  .strict()

type Fixture = Awaited<ReturnType<typeof createOAuthAccountsFixture>>

async function accounts(fixture: Fixture, type: 'oauth' | 'key' = 'oauth') {
  const response = await fixture.app.request('/providers/fixture-auth/accounts')
  expect(response.status).toBe(200)
  const text = await response.text()
  expect(text.includes('fixture-access-')).toBe(false)
  expect(text.includes('fixture-refresh-')).toBe(false)
  expect(text.includes('fixture-key-')).toBe(false)
  return z
    .object({
      accounts: z.array(
        type === 'key' ? AccountSchema.extend({ type: z.literal('key'), methodID: z.null() }) : AccountSchema,
      ),
    })
    .strict()
    .parse(JSON.parse(text)).accounts
}

async function connect(fixture: Fixture, code: string) {
  await expect
    .poll(
      async () =>
        (await fixture.api.integration.get({ integrationID: 'fixture-auth' })).data.methods.map((method) =>
          method.type === 'oauth' ? method.id : method.type,
        ),
      { timeout: 60000, interval: 250 },
    )
    .toContain('fixture-code')
  const response = await fixture.app.request('/oauth/fixture-auth/oauth/authorize', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ methodID: 'fixture-code' }),
  })
  expect(response.status).toBe(200)
  const attempt = z.object({ attemptID: z.string(), mode: z.literal('code') }).parse(await response.json())
  const completed = await fixture.app.request('/oauth/fixture-auth/oauth/callback', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ attemptID: attempt.attemptID, code }),
  })
  expect(completed.status).toBe(200)
  expect(await completed.json()).toEqual({ success: true })
  return accounts(fixture)
}

describe.skipIf(binary === null)('OAuth accounts against real OpenCode 2', () => {
  it('preserves both key connections and sends the selected account key to the model', async () => {
    const fixture = await createOAuthAccountsFixture()
    try {
      await expect
        .poll(
          async () =>
            (
              await fixture.api.integration.get({
                integrationID: 'fixture-auth',
              })
            ).data.methods.map((method) => method.type),
          { timeout: 60000, interval: 250 },
        )
        .toContain('key')
      expect(await accounts(fixture, 'key')).toEqual([])
      const addedFirst = await fixture.app.request('/providers/fixture-auth/credentials', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ apiKey: 'fixture-key-first' }),
      })
      expect(addedFirst.status).toBe(200)
      expect(await addedFirst.json()).toEqual({ success: true })
      const firstAccounts = await accounts(fixture, 'key')
      expect(firstAccounts).toHaveLength(1)
      const [first] = firstAccounts
      if (!first) throw new Error('First key account missing')
      expect(first.active).toBe(true)
      const addedSecond = await fixture.app.request('/providers/fixture-auth/credentials', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ apiKey: 'fixture-key-second' }),
      })
      expect(addedSecond.status).toBe(200)
      expect(await addedSecond.json()).toEqual({ success: true })
      const connected = await accounts(fixture, 'key')
      expect(connected).toHaveLength(2)
      const second = connected.find((account) => account.id !== first.id)
      if (!second) throw new Error('Second key account missing')
      expect(connected).toEqual(
        expect.arrayContaining([
          { ...first, active: false },
          { ...second, active: true },
        ]),
      )
      await fixture.prompt()
      expect(fixture.markers).toEqual(['Bearer fixture-key-second'])
      const activated = await fixture.app.request(`/providers/fixture-auth/accounts/${first.id}/activate`, {
        method: 'POST',
      })
      expect(activated.status).toBe(200)
      expect(await activated.json()).toEqual({
        success: true,
        activeAccountId: first.id,
      })
      const switched = await accounts(fixture, 'key')
      expect(switched).toHaveLength(2)
      expect(switched).toEqual(
        expect.arrayContaining([
          { ...first, active: true },
          { ...second, active: false },
        ]),
      )
      await fixture.prompt()
      expect(fixture.markers).toEqual(['Bearer fixture-key-second', 'Bearer fixture-key-first'])
    } finally {
      await fixture.dispose()
    }
  }, 120000)

  it('preserves both OAuth connections and sends the selected account token to the model', async () => {
    const fixture = await createOAuthAccountsFixture()
    try {
      expect(await accounts(fixture)).toEqual([])
      const [first] = await connect(fixture, 'first')
      if (!first) throw new Error('First OAuth account missing')
      expect(first.active).toBe(true)
      const connected = await connect(fixture, 'second')
      expect(connected).toHaveLength(2)
      const second = connected.find((account) => account.id !== first.id)
      if (!second) throw new Error('Second OAuth account missing')
      expect(connected.find((account) => account.id === first.id)?.active).toBe(false)
      expect(second.active).toBe(true)
      await fixture.prompt()
      expect(fixture.markers).toEqual(['Bearer fixture-access-second'])

      const activated = await fixture.app.request(`/providers/fixture-auth/accounts/${first.id}/activate`, {
        method: 'POST',
      })
      expect(activated.status).toBe(200)
      expect(await activated.json()).toEqual({
        success: true,
        activeAccountId: first.id,
      })
      expect(await accounts(fixture)).toEqual(
        expect.arrayContaining([
          { ...first, active: true },
          { ...second, active: false },
        ]),
      )
      await fixture.prompt()
      expect(fixture.markers).toEqual(['Bearer fixture-access-second', 'Bearer fixture-access-first'])
    } finally {
      await fixture.dispose()
    }
  }, 120000)

  it('refreshes only the explicitly resolved inactive credential and preserves the active account', async () => {
    const fixture = await createOAuthAccountsFixture()
    try {
      const [first] = await connect(fixture, 'first-expired')
      if (!first) throw new Error('First OAuth account missing')
      await connect(fixture, 'second')
      const before = await fixture.api.credential.list()
      const storedFirst = before.find((credential) => credential.id === first.id)
      const storedSecond = before.find((credential) => credential.id !== first.id)
      if (!storedFirst || !storedSecond) throw new Error('OAuth credentials missing')
      if (storedFirst.value.type !== 'oauth') throw new Error('Expected OAuth credential')
      expect(storedFirst.value.expires).toBe(1)
      await fixture.resolveCredential(first.id)
      await fixture.prompt()
      const receipt = z
        .object({
          refreshed: z.array(z.string()),
          value: z.object({
            access: z.string(),
            refresh: z.string(),
            expires: z.number(),
          }),
        })
        .parse(await fixture.receipt())
      expect(receipt.refreshed).toEqual(['fixture-refresh-first'])
      expect(receipt.value.access === 'fixture-access-first-renewed').toBe(true)
      expect(receipt.value.refresh === 'fixture-refresh-first-renewed').toBe(true)
      expect(receipt.value.expires).toBeGreaterThan(Date.now())
      const after = await fixture.api.credential.list()
      expect(after).toHaveLength(2)
      expect(after.find((credential) => credential.id === storedSecond.id)).toEqual(storedSecond)
      const refreshed = after.find((credential) => credential.id === first.id)
      expect(refreshed?.active).toBe(false)
      expect(refreshed?.value).toMatchObject(receipt.value)
      expect(fixture.markers).toEqual(['Bearer fixture-access-second'])
      expect((await accounts(fixture)).filter((account) => account.active).map((account) => account.id)).toEqual([
        storedSecond.id,
      ])
    } finally {
      await fixture.dispose()
    }
  }, 120000)
})
