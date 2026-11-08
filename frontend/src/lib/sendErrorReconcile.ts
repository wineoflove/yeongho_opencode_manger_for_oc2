import type { SessionTranscript } from '@/lib/session-projection/applySessionEvent'
import { useSendErrorStore } from '@/stores/sendErrorStore'

/**
 * Clears a stale network send error once a fully fetched transcript shows the failed prompt was delivered, either as
 * a user message or as a pending inbox entry. This recovers sessions whose confirming stream events were missed
 * (for example in a backgrounded tab) while keeping the error when the prompt text never arrived.
 */
export function reconcileConfirmedPrompt(sessionID: string, transcript: SessionTranscript): void {
  const store = useSendErrorStore.getState()
  const error = store.getError(sessionID)
  const expected = error?.kind === 'network' ? error.failedPrompt?.trim() : undefined
  if (!expected) return
  const delivered =
    transcript.messages.some((message) => message.type === 'user' && message.text.trim() === expected) ||
    transcript.pending.some((entry) => entry.type === 'user' && entry.payload.text.trim() === expected)
  if (delivered) store.clearNetworkError(sessionID)
}
