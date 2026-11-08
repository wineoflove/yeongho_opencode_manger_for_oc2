import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fetchSystemStatus } from './system'
import { fetchWrapper } from './fetchWrapper'
import { systemStatusFixture } from '@/test/systemStatusFixture'

vi.mock('./fetchWrapper', () => ({ fetchWrapper: vi.fn() }))

describe('fetchSystemStatus', () => {
  beforeEach(() => vi.mocked(fetchWrapper).mockReset())

  it('requests and parses the shared aggregate response', async () => {
    vi.mocked(fetchWrapper).mockResolvedValue(systemStatusFixture)
    expect(await fetchSystemStatus()).toEqual(systemStatusFixture)
    expect(fetchWrapper).toHaveBeenCalledWith(expect.stringMatching(/\/api\/system\/status$/))
  })

  it('rejects an invalid payload rather than rendering fabricated metrics', async () => {
    vi.mocked(fetchWrapper).mockResolvedValue({ ...systemStatusFixture, intervalSeconds: 5 })
    await expect(fetchSystemStatus()).rejects.toThrow()
  })
})
