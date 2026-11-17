import { createDecipheriv, scryptSync } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { decodeLegacyOpenAiStore, encodeLegacyOpenAiStore } from '../../src/services/legacy-openai-store'

const envelopeSchema = z.object({
  version: z.literal(2),
  encrypted: z.literal(true),
  salt: z.string(),
  iv: z.string(),
  tag: z.string(),
  data: z.string(),
})
const source = {
  version: 2,
  accounts: {
    first: { refreshToken: 'synthetic-secret', expiresAt: 1800000000123 },
  },
  metadata: { label: '합성 계정', enabled: false, optional: null },
}
const passphrase = 'synthetic-passphrase'

describe('legacy OpenAI encrypted store serialization', () => {
  it('uses the legacy AES-GCM envelope and preserves JSON values without plaintext output', () => {
    const serialized = encodeLegacyOpenAiStore(source, passphrase)
    const envelope = envelopeSchema.parse(JSON.parse(serialized))
    expect(serialized).not.toContain('synthetic-secret')
    expect(Buffer.from(envelope.salt, 'base64')).toHaveLength(16)
    expect(Buffer.from(envelope.iv, 'base64')).toHaveLength(12)
    expect(Buffer.from(envelope.tag, 'base64')).toHaveLength(16)
    const key = scryptSync(passphrase, Buffer.from(envelope.salt, 'base64'), 32)
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'))
    decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'))
    const plaintext = Buffer.concat([decipher.update(Buffer.from(envelope.data, 'base64')), decipher.final()])
    expect(JSON.parse(plaintext.toString('utf8'))).toEqual(source)
    expect(decodeLegacyOpenAiStore(serialized, passphrase)).toEqual(source)
    key.fill(0)
    plaintext.fill(0)
  })

  it('uses fresh salt and IV for each encryption', () => {
    const first = envelopeSchema.parse(JSON.parse(encodeLegacyOpenAiStore(source, passphrase)))
    const second = envelopeSchema.parse(JSON.parse(encodeLegacyOpenAiStore(source, passphrase)))
    expect(first.salt).not.toBe(second.salt)
    expect(first.iv).not.toBe(second.iv)
    expect(first.data).not.toBe(second.data)
  })

  it.each(['salt', 'iv', 'tag', 'data'] as const)(
    'rejects a modified %s instead of returning corrupt credentials',
    (field) => {
      const envelope = envelopeSchema.parse(JSON.parse(encodeLegacyOpenAiStore(source, passphrase)))
      const bytes = Buffer.from(envelope[field], 'base64')
      bytes[0] = bytes[0] === 0 ? 1 : 0
      expect(() =>
        decodeLegacyOpenAiStore(JSON.stringify({ ...envelope, [field]: bytes.toString('base64') }), passphrase),
      ).toThrow('DECRYPTION_FAILED')
    },
  )

  it('rejects missing and incorrect encryption credentials without exposing plaintext', () => {
    expect(() => encodeLegacyOpenAiStore(source, '')).toThrow('STORE_LOCKED')
    const serialized = encodeLegacyOpenAiStore(source, passphrase)
    expect(() => decodeLegacyOpenAiStore(serialized, 'incorrect')).toThrow('DECRYPTION_FAILED')
  })

  it.each([undefined, { value: undefined }, { value: BigInt(1) }, { value: Number.NaN }])(
    'refuses non-JSON input rather than silently dropping values',
    (value) => expect(() => encodeLegacyOpenAiStore(value, passphrase)).toThrow('ENCRYPTION_FAILED'),
  )
})
