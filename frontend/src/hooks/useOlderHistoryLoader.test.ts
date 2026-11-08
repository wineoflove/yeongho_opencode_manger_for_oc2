import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import type { UIEvent } from 'react'
import type { SessionMessageInfo } from '@opencode-manager/shared/opencode'
import { useOlderHistoryLoader } from './useOlderHistoryLoader'
import { useAutoScroll } from './useAutoScroll'
import type { FetchOlderOptions } from './useSessionTranscript'

const ROW = 100
const VIEWPORT = 400

function createTranscript(initial: string[]) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  let rows = initial
  let scrollTop = 0
  const maxScroll = () => Math.max(0, rows.length * ROW - VIEWPORT)
  Object.defineProperty(container, 'clientHeight', {
    configurable: true,
    get: () => VIEWPORT,
  })
  Object.defineProperty(container, 'scrollHeight', {
    configurable: true,
    get: () => rows.length * ROW,
  })
  Object.defineProperty(container, 'scrollTop', {
    configurable: true,
    get: () => scrollTop,
    set: (value: number) => {
      scrollTop = Math.max(0, Math.min(value, maxScroll()))
      container.dispatchEvent(new Event('scroll'))
    },
  })
  container.getBoundingClientRect = () => ({ top: 0 }) as DOMRect
  const render = (next: string[]) => {
    rows = next
    container.replaceChildren(
      ...next.map((id) => {
        const element = document.createElement('div')
        element.dataset.messageId = id
        element.getBoundingClientRect = () => ({ top: rows.indexOf(id) * ROW - scrollTop }) as DOMRect
        return element
      }),
    )
  }
  render(initial)
  return {
    container,
    render,
    get rows() {
      return rows
    },
    scrollTo: (value: number) => {
      scrollTop = Math.max(0, Math.min(value, maxScroll()))
    },
    topRowOffset: (id: string) => rows.indexOf(id) * ROW - scrollTop,
    remove: () => container.remove(),
  }
}

type Transcript = ReturnType<typeof createTranscript>

const ids = (from: number, to: number) => Array.from({ length: to - from }, (_, index) => `msg_${from + index}`)

function scrollEvent(container: HTMLDivElement) {
  return { currentTarget: container } as unknown as UIEvent<HTMLDivElement>
}

interface Deferred {
  promise: Promise<boolean>
  resolve: (value: boolean) => void
  reject: (error: Error) => void
}

function deferred(): Deferred {
  let resolve: Deferred['resolve'] = () => undefined
  let reject: Deferred['reject'] = () => undefined
  const promise = new Promise<boolean>((onResolve, onReject) => {
    resolve = onResolve
    reject = onReject
  })
  return { promise, resolve, reject }
}

function deferredFetch() {
  const calls: { options: FetchOlderOptions | undefined; result: Deferred }[] = []
  const fetchOlder = vi.fn((options?: FetchOlderOptions) => {
    const result = deferred()
    calls.push({ options, result })
    return result.promise
  })
  return { fetchOlder, calls }
}

interface Props {
  scopeKey: string
  firstMessageId: string | undefined
  olderPageCommit: number | undefined
  hasOlder: boolean
}

function setup(transcript: Transcript, fetchOlder: (options?: FetchOlderOptions) => Promise<boolean>) {
  const containerRef = { current: transcript.container as HTMLDivElement | null }
  const onRequest = vi.fn()
  const initialProps: Props = {
    scopeKey: 'a',
    firstMessageId: transcript.rows[0],
    olderPageCommit: undefined,
    hasOlder: true,
  }
  const hook = renderHook(
    (props: Props) => useOlderHistoryLoader({ containerRef, fetchOlder, thresholdPx: 200, onRequest, ...props }),
    { initialProps },
  )
  const show = (rows: string[], props: Partial<Props> = {}) => {
    transcript.render(rows)
    hook.rerender({ ...initialProps, firstMessageId: rows[0], ...props })
  }
  const scroll = () => act(() => hook.result.current.handleScroll(scrollEvent(transcript.container)))
  return { ...hook, containerRef, onRequest, show, scroll }
}

const nextFrames = () =>
  act(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))

describe('useOlderHistoryLoader', () => {
  let transcript: Transcript

  beforeEach(() => {
    transcript = createTranscript(ids(10, 20))
  })

  afterEach(() => {
    transcript.remove()
  })

  it('keeps the top message at the same position once the older page is prepended', async () => {
    const { fetchOlder, calls } = deferredFetch()
    const { scroll, show, onRequest } = setup(transcript, fetchOlder)
    transcript.scrollTo(120)

    scroll()
    expect(onRequest).toHaveBeenCalledOnce()
    await act(async () => {
      calls[0].options?.onBeforePrepend?.(1)
      show(ids(5, 20), { olderPageCommit: 1 })
      calls[0].result.resolve(true)
    })

    expect(fetchOlder).toHaveBeenCalledOnce()
    expect(transcript.topRowOffset('msg_10')).toBe(-120)
  })

  it('follows the reader while the request is pending', async () => {
    const { fetchOlder, calls } = deferredFetch()
    const { scroll, show } = setup(transcript, fetchOlder)
    transcript.scrollTo(150)
    scroll()
    transcript.scrollTo(30)
    scroll()

    await act(async () => {
      calls[0].options?.onBeforePrepend?.(1)
      show(ids(5, 20), { olderPageCommit: 1 })
      calls[0].result.resolve(true)
    })

    expect(fetchOlder).toHaveBeenCalledOnce()
    expect(transcript.topRowOffset('msg_10')).toBe(-30)
  })

  it('restores when the prepend is committed after the request settled', async () => {
    const { fetchOlder, calls } = deferredFetch()
    const { scroll, show } = setup(transcript, fetchOlder)
    transcript.scrollTo(80)
    scroll()

    await act(async () => {
      calls[0].options?.onBeforePrepend?.(1)
      calls[0].result.resolve(true)
    })
    act(() => show(ids(5, 20), { olderPageCommit: 1 }))

    expect(transcript.topRowOffset('msg_10')).toBe(-80)
  })

  it.each([
    ['failed', (result: Deferred) => result.reject(new Error('offline'))],
    ['changed nothing', (result: Deferred) => result.resolve(false)],
  ])('drops the anchor of a request that %s, so a later head change does not move the view', async (_, settle) => {
    const { fetchOlder, calls } = deferredFetch()
    const { scroll, show } = setup(transcript, fetchOlder)
    transcript.scrollTo(0)
    scroll()
    await act(async () => settle(calls[0].result))

    transcript.scrollTo(300)
    act(() => show(ids(30, 40), { olderPageCommit: 7 }))

    expect(transcript.container.scrollTop).toBe(300)
    transcript.scrollTo(0)
    scroll()
    expect(fetchOlder).toHaveBeenCalledTimes(2)
  })

  it('drops a pending anchor as soon as the transcript head is replaced, before the response arrives', async () => {
    const { fetchOlder, calls } = deferredFetch()
    const { scroll, show } = setup(transcript, fetchOlder)
    transcript.scrollTo(50)
    scroll()

    transcript.scrollTo(250)
    act(() => show(ids(30, 40)))
    expect(transcript.container.scrollTop).toBe(250)

    transcript.scrollTo(0)
    scroll()
    expect(fetchOlder).toHaveBeenCalledTimes(2)

    await act(async () => {
      calls[0].options?.onBeforePrepend?.(1)
      calls[0].result.resolve(true)
    })
    act(() => show(ids(25, 40), { olderPageCommit: 1 }))
    expect(transcript.container.scrollTop).toBe(0)
  })

  it('does not restore when the commit after the write shows the same head without that page', async () => {
    const { fetchOlder, calls } = deferredFetch()
    const { scroll, show } = setup(transcript, fetchOlder)
    transcript.scrollTo(60)
    scroll()

    transcript.scrollTo(200)
    await act(async () => {
      calls[0].options?.onBeforePrepend?.(1)
      show(ids(10, 20))
      calls[0].result.resolve(true)
    })
    expect(transcript.container.scrollTop).toBe(200)

    act(() => show(ids(5, 20), { olderPageCommit: 1 }))
    expect(transcript.container.scrollTop).toBe(200)
    transcript.scrollTo(0)
    scroll()
    expect(fetchOlder).toHaveBeenCalledTimes(2)
  })

  it('does not restore when a different page commit is rendered', async () => {
    const { fetchOlder, calls } = deferredFetch()
    const { scroll, show } = setup(transcript, fetchOlder)
    transcript.scrollTo(60)
    scroll()

    transcript.scrollTo(200)
    await act(async () => {
      calls[0].options?.onBeforePrepend?.(2)
      show(ids(5, 20), { olderPageCommit: 1 })
      calls[0].result.resolve(true)
    })

    expect(transcript.container.scrollTop).toBe(200)
  })

  it('releases the anchor when no commit follows a successful write within two frames', async () => {
    const { fetchOlder, calls } = deferredFetch()
    const { scroll } = setup(transcript, fetchOlder)
    transcript.scrollTo(40)
    scroll()

    await act(async () => {
      calls[0].options?.onBeforePrepend?.(1)
      calls[0].result.resolve(true)
    })
    scroll()
    expect(fetchOlder).toHaveBeenCalledOnce()

    await nextFrames()
    scroll()
    expect(fetchOlder).toHaveBeenCalledTimes(2)
  })

  it('isolates a session switch from the previous session request', async () => {
    const { fetchOlder, calls } = deferredFetch()
    const { scroll, show } = setup(transcript, fetchOlder)
    transcript.scrollTo(40)
    scroll()

    transcript.scrollTo(100)
    act(() => show(ids(50, 60), { scopeKey: 'b' }))
    await act(async () => {
      calls[0].options?.onBeforePrepend?.(1)
      calls[0].result.resolve(true)
    })
    act(() => show(ids(45, 60), { scopeKey: 'b', olderPageCommit: 1 }))
    expect(transcript.container.scrollTop).toBe(100)

    transcript.scrollTo(0)
    scroll()
    expect(fetchOlder).toHaveBeenCalledTimes(2)
  })

  it('drops the anchor when the scroll container is replaced', async () => {
    const { fetchOlder, calls } = deferredFetch()
    const { scroll, show, containerRef } = setup(transcript, fetchOlder)
    transcript.scrollTo(40)
    scroll()

    const replacement = createTranscript(ids(10, 20))
    containerRef.current = replacement.container
    act(() => show(ids(10, 20)))
    await act(async () => {
      calls[0].options?.onBeforePrepend?.(1)
      show(ids(5, 20), { olderPageCommit: 1 })
      calls[0].result.resolve(true)
    })

    expect(transcript.container.scrollTop).toBe(40)
    replacement.remove()
  })

  it('does not restore after cancel, as when the reader jumps to the latest message', async () => {
    const { fetchOlder, calls } = deferredFetch()
    const { scroll, show, result } = setup(transcript, fetchOlder)
    transcript.scrollTo(40)
    scroll()

    act(() => result.current.cancel())
    transcript.scrollTo(600)
    await act(async () => {
      calls[0].options?.onBeforePrepend?.(1)
      show(ids(5, 20), { olderPageCommit: 1 })
      calls[0].result.resolve(true)
    })

    expect(transcript.container.scrollTop).toBe(600)
  })

  it('falls back to the distance from the bottom when no message is rendered', async () => {
    const { fetchOlder, calls } = deferredFetch()
    const { scroll, show } = setup(transcript, fetchOlder)
    transcript.scrollTo(100)
    transcript.container.replaceChildren()
    scroll()

    await act(async () => {
      calls[0].options?.onBeforePrepend?.(1)
      show(ids(5, 20), { olderPageCommit: 1 })
      calls[0].result.resolve(true)
    })

    expect(transcript.container.scrollTop).toBe(1500 - (1000 - 100))
  })

  it('ignores scrolls away from the top and does nothing without older history', () => {
    const { fetchOlder } = deferredFetch()
    const { scroll, show } = setup(transcript, fetchOlder)
    transcript.scrollTo(500)
    scroll()
    expect(fetchOlder).not.toHaveBeenCalled()

    act(() => show(ids(10, 20), { hasOlder: false }))
    transcript.scrollTo(0)
    scroll()
    expect(fetchOlder).not.toHaveBeenCalled()
  })
})
describe('useOlderHistoryLoader with useAutoScroll', () => {
  let transcript: Transcript

  beforeEach(() => {
    vi.useFakeTimers()
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) =>
      window.setTimeout(() => callback(performance.now()), 0),
    )
    transcript = createTranscript(ids(10, 20))
  })

  afterEach(() => {
    transcript.remove()
    vi.unstubAllGlobals()
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  const message = (id: string) => ({ id, type: 'assistant', time: { created: 0 } }) as SessionMessageInfo

  function setupCombined(fetchOlder: (options?: FetchOlderOptions) => Promise<boolean>, coordinate: boolean) {
    const containerRef = {
      current: transcript.container as HTMLDivElement | null,
    }
    const hook = renderHook(
      ({ rows, olderPageCommit }: { rows: string[]; olderPageCommit?: number }) => {
        const messages = rows.map(message)
        const autoScroll = useAutoScroll({
          container: transcript.container,
          messages,
          sessionId: 'session',
          contentVersion: messages.length,
          isContentReady: true,
        })
        const loader = useOlderHistoryLoader({
          containerRef,
          scopeKey: 'session',
          firstMessageId: rows[0],
          olderPageCommit,
          hasOlder: true,
          fetchOlder,
          thresholdPx: 200,
          onRequest: coordinate ? autoScroll.disengage : undefined,
        })
        return { ...autoScroll, ...loader }
      },
      { initialProps: { rows: transcript.rows, olderPageCommit: undefined as number | undefined } },
    )
    act(() => vi.advanceTimersByTime(50))
    return hook
  }

  it.each([
    [true, -60],
    [false, null],
  ])(
    'keeps the restored position over bottom-following when the request disengages it (coordinated: %s)',
    async (coordinate, expectedOffset) => {
      const { fetchOlder, calls } = deferredFetch()
      const { result, rerender } = setupCombined(fetchOlder, coordinate)
      expect(transcript.container.scrollTop).toBe(600)

      transcript.scrollTo(60)
      act(() => result.current.handleScroll(scrollEvent(transcript.container)))
      await act(async () => {
        calls[0].options?.onBeforePrepend?.(1)
        transcript.render(ids(5, 20))
        rerender({ rows: ids(5, 20), olderPageCommit: 1 })
        calls[0].result.resolve(true)
      })
      act(() => vi.advanceTimersByTime(50))

      if (expectedOffset === null) {
        expect(transcript.container.scrollTop).toBe(15 * ROW - VIEWPORT)
      } else {
        expect(transcript.topRowOffset('msg_10')).toBe(expectedOffset)
      }
    },
  )
})
