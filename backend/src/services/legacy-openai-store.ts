import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto'
import { z } from 'zod'

const encryptedSchema = z.object({
  encrypted: z.literal(true),
  data: z.string().min(1),
  salt: z.string().min(1),
  iv: z.string().min(1),
  tag: z.string().min(1),
})

export class LegacyOpenAiStoreError extends Error {
  constructor(readonly code: 'INVALID_STORE' | 'STORE_LOCKED' | 'DECRYPTION_FAILED' | 'ENCRYPTION_FAILED') {
    super(code)
    this.name = 'LegacyOpenAiStoreError'
  }
}

export function encodeLegacyOpenAiStore(source: unknown, passphrase: string): string {
  if (!passphrase) throw new LegacyOpenAiStoreError('STORE_LOCKED')
  let key: Buffer | undefined
  let plaintext: Buffer | undefined
  try {
    const value = z.json().parse(source)
    plaintext = Buffer.from(JSON.stringify(value), 'utf8')
    const salt = randomBytes(16)
    const iv = randomBytes(12)
    key = scryptSync(passphrase, salt, 32)
    const cipher = createCipheriv('aes-256-gcm', key, iv)
    const data = Buffer.concat([cipher.update(plaintext), cipher.final()])
    return JSON.stringify({
      version: 2,
      encrypted: true,
      salt: salt.toString('base64'),
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      data: data.toString('base64'),
    })
  } catch {
    throw new LegacyOpenAiStoreError('ENCRYPTION_FAILED')
  } finally {
    key?.fill(0)
    plaintext?.fill(0)
  }
}

export function decodeLegacyOpenAiStore(serialized: string, passphrase?: string): unknown {
  let value: unknown
  try {
    value = JSON.parse(serialized)
  } catch {
    throw new LegacyOpenAiStoreError('INVALID_STORE')
  }
  const marker = z.object({ encrypted: z.boolean().optional() }).passthrough().safeParse(value)
  if (!marker.success) throw new LegacyOpenAiStoreError('INVALID_STORE')
  if (marker.data.encrypted !== true) return value
  if (!passphrase) throw new LegacyOpenAiStoreError('STORE_LOCKED')
  const parsed = encryptedSchema.safeParse(value)
  if (!parsed.success) throw new LegacyOpenAiStoreError('INVALID_STORE')
  const encrypted = parsed.data
  let key: Buffer | undefined
  let plaintext: Buffer | undefined
  try {
    key = scryptSync(passphrase, Buffer.from(encrypted.salt, 'base64'), 32)
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(encrypted.iv, 'base64'))
    decipher.setAuthTag(Buffer.from(encrypted.tag, 'base64'))
    plaintext = Buffer.concat([decipher.update(Buffer.from(encrypted.data, 'base64')), decipher.final()])
    return JSON.parse(plaintext.toString('utf8'))
  } catch {
    throw new LegacyOpenAiStoreError('DECRYPTION_FAILED')
  } finally {
    key?.fill(0)
    plaintext?.fill(0)
  }
}
