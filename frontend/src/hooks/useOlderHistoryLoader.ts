import { useCallback, useLayoutEffect, useRef, type RefObject, type UIEvent } from 'react'
import type { FetchOlderOptions } from './useSessionTranscript'

interface OlderHistoryLoaderOptions {
  containerRef: RefObject<HTMLDivElement | null>
  scopeKey: string
  firstMessageId: string | undefined
  olderPageCommit: number | undefined
  hasOlder: boolean
  fetchOlder: ((options?: FetchOlderOptions) => Promise<boolean>) | undefined
  thresholdPx: number
  onRequest?: () => void
}

interface ScrollAnchor {
  scopeKey: string
  container: HTMLDivElement
  elementId: string | null
  offsetTop: number
  distanceFromBottom: number
  requestFirstId: string | undefined
  expectedCommit: number | null
}

const MESSAGE_SELECTOR = '[data-message-id]'

function offsetWithin(container: HTMLDivElement, element: Element) {
  return element.getBoundingClientRect().top - container.getBoundingClientRect().top
}

function findMessageElement(container: HTMLDivElement, id: string) {
  return Array.from(container.querySelectorAll<HTMLElement>(MESSAGE_SELECTOR)).find(
    (element) => element.dataset.messageId === id,
  )
}

function captureAnchor(anchor: ScrollAnchor) {
  const { container } = anchor
  const element = container.querySelector<HTMLElement>(MESSAGE_SELECTOR)
  anchor.elementId = element?.dataset.messageId ?? null
  anchor.offsetTop = element ? offsetWithin(container, element) : 0
  anchor.distanceFromBottom = container.scrollHeight - container.scrollTop
}

function restoreAnchor(anchor: ScrollAnchor) {
  const { container } = anchor
  const element = anchor.elementId ? findMessageElement(container, anchor.elementId) : undefined
  if (element) {
    container.scrollTop += offsetWithin(container, element) - anchor.offsetTop
    return
  }
  container.scrollTop = container.scrollHeight - anchor.distanceFromBottom
}

async function requestOlderPage(
  fetchOlder: (options?: FetchOlderOptions) => Promise<boolean>,
  anchor: ScrollAnchor,
  anchorRef: RefObject<ScrollAnchor | null>,
) {
  let prepended = false
  try {
    prepended = await fetchOlder({
      onBeforePrepend: (olderPageCommit) => {
        if (anchorRef.current === anchor) anchor.expectedCommit = olderPageCommit
      },
    })
  } catch {
    prepended = false
  }
  if (anchorRef.current !== anchor) return
  if (!prepended) {
    anchorRef.current = null
    return
  }
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      if (anchorRef.current === anchor) anchorRef.current = null
    }),
  )
}

/**
 * Loads older history when the transcript is scrolled near its top and keeps the reader's place once that
 * page is prepended. The anchor belongs to one request in one scope (server, session and revert boundary)
 * and one scroll container, and follows the reader's scrolling until the page is written. The first commit
 * after the write decides it: the reader's place is restored only when that commit renders the page's
 * `olderPageCommit`. The anchor is dropped when the request fails, changes nothing or is superseded, when the
 * transcript head changes before the response, when the scope or container changes, or when no commit
 * follows the write within two frames.
 */
export function useOlderHistoryLoader({
  containerRef,
  scopeKey,
  firstMessageId,
  olderPageCommit,
  hasOlder,
  fetchOlder,
  thresholdPx,
  onRequest,
}: OlderHistoryLoaderOptions) {
  const anchorRef = useRef<ScrollAnchor | null>(null)

  const cancel = useCallback(() => {
    anchorRef.current = null
  }, [])

  const handleScroll = useCallback(
    (event: UIEvent<HTMLDivElement>) => {
      const container = event.currentTarget
      const pending = anchorRef.current
      if (pending && pending.scopeKey === scopeKey && pending.container === container) {
        if (pending.expectedCommit === null) captureAnchor(pending)
        return
      }
      if (!hasOlder || !fetchOlder || container.scrollTop > thresholdPx) return
      const anchor: ScrollAnchor = {
        scopeKey,
        container,
        elementId: null,
        offsetTop: 0,
        distanceFromBottom: 0,
        requestFirstId: firstMessageId,
        expectedCommit: null,
      }
      captureAnchor(anchor)
      anchorRef.current = anchor
      onRequest?.()
      void requestOlderPage(fetchOlder, anchor, anchorRef)
    },
    [fetchOlder, firstMessageId, hasOlder, onRequest, scopeKey, thresholdPx],
  )

  useLayoutEffect(() => {
    const anchor = anchorRef.current
    if (!anchor) return
    if (anchor.scopeKey !== scopeKey || anchor.container !== containerRef.current) {
      anchorRef.current = null
      return
    }
    if (anchor.expectedCommit === null) {
      if (firstMessageId !== anchor.requestFirstId) anchorRef.current = null
      return
    }
    anchorRef.current = null
    if (olderPageCommit === anchor.expectedCommit) restoreAnchor(anchor)
  })

  return { handleScroll, cancel }
}
