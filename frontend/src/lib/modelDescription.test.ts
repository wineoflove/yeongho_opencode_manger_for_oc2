import { describe, expect, it } from 'vitest'
import type { Model } from '@/api/providers'
import { describeModel, modelStatusLabel } from './modelDescription'

const base: Model = { id: 'm', name: 'M', released: 0, free: false }

describe('describeModel', () => {
  it('lists provider, context, base price per million tokens and capabilities', () => {
    expect(
      describeModel('OpenAI', {
        ...base,
        limit: { context: 200_000, output: 8_000 },
        price: { input: 3, output: 15 },
        tools: true,
        attachments: true,
      }),
    ).toBe('OpenAI · 200k context · $3.00 / $15.00 per 1M · Tools · Files')
  })

  it('shows free models without a price and omits unknown details', () => {
    expect(describeModel('Local', { ...base, free: true, price: { input: 0, output: 0 } })).toBe('Local · Free')
    expect(describeModel('Unknown', undefined)).toBe('Unknown')
  })
})

describe('modelStatusLabel', () => {
  it('labels pre-release and deprecated models only', () => {
    expect(modelStatusLabel({ ...base, status: 'beta' })).toBe('Beta')
    expect(modelStatusLabel({ ...base, status: 'deprecated' })).toBe('Deprecated')
    expect(modelStatusLabel({ ...base, status: 'active' })).toBeNull()
    expect(modelStatusLabel(undefined)).toBeNull()
  })
})
