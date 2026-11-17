import { describe, expect, it } from 'vitest'
import { collectClaudeDirectoryIdle } from '../../src/services/claude-directory-idle'

describe('bounded directory idle collection', () => {
  it('checks every unique directory without treating failures as idle', async () => {
    const result = await collectClaudeDirectoryIdle(
      ['/idle', '/busy', '/invalid', '/error', '/idle'],
      async (directory) => {
        switch (directory) {
          case '/idle':
            return {}
          case '/busy':
            return { session: { type: 'retry' } }
          case '/invalid':
            return { session: { type: 'unexpected' } }
          case '/error':
            throw new Error('offline')
          default:
            throw new Error('unexpected')
        }
      },
      new AbortController().signal,
    )
    expect(
      result
        .map(({ directory, state, busySessions }) => ({
          directory,
          state,
          busySessions,
        }))
        .sort((a, b) => a.directory.localeCompare(b.directory)),
    ).toEqual([
      { directory: '/busy', state: 'busy', busySessions: 1 },
      { directory: '/error', state: 'unknown', busySessions: 0 },
      { directory: '/idle', state: 'idle', busySessions: 0 },
      { directory: '/invalid', state: 'unknown', busySessions: 0 },
    ])
  })
  it('does not send requests after the shared deadline has elapsed', async () => {
    const controller = new AbortController()
    controller.abort()
    let calls = 0
    const result = await collectClaudeDirectoryIdle(
      ['/one', '/two'],
      async () => {
        calls++
        return {}
      },
      controller.signal,
    )
    expect(calls).toBe(0)
    expect(result.map((entry) => entry.state)).toEqual(['unknown', 'unknown'])
  })
  it('limits concurrent observations to four while covering all directories', async () => {
    let active = 0
    let maxActive = 0
    let release: (() => void) | undefined
    const barrier = new Promise<void>((resolve) => {
      release = resolve
    })
    const result = await collectClaudeDirectoryIdle(
      Array.from({ length: 12 }, (_, index) => `/dir-${index}`),
      async () => {
        active++
        maxActive = Math.max(maxActive, active)
        if (active === 4) release?.()
        await barrier
        active--
        return {}
      },
      AbortSignal.timeout(1000),
    )
    expect(maxActive).toBe(4)
    expect(result).toHaveLength(12)
    expect(result.every((entry) => entry.state === 'idle')).toBe(true)
  })
})
