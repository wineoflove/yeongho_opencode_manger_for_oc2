import { expect, it } from 'bun:test'
import { completionReceipt } from './cleanup.mjs'

const feedback = 'ses_feedback'
const batch = 'abcdef0123456789abcdef01'
const run = {
  status: 'completed',
  finished_at: 1000,
  session_id: 'ses_run',
  response_text: JSON.stringify({ status: 'done', mode: 'daily', batch, feedbackSession: feedback }),
}

it('recognizes completed successful review output after a grace period', () => {
  expect(completionReceipt(run, feedback, 61001)).toEqual({ batch, mode: 'daily' })
})
it('recognizes receipts with nested analysis usage in wrapper output', () => {
  const receipt = JSON.stringify({
    status: 'done',
    mode: 'daily',
    batch,
    feedbackSession: feedback,
    analysisUsage: { input: 17, models: { 'provider/model': { input: 17 } } },
  })
  expect(
    completionReceipt({ ...run, response_text: `Review completed:\n\`\`\`json\n${receipt}\n\`\`\`` }, feedback, 61001),
  ).toEqual({ batch, mode: 'daily' })
})
it('never selects the feedback session itself', () => {
  expect(completionReceipt({ ...run, session_id: feedback }, feedback, 61001)).toBeNull()
})
it('does not select a running or recently finished session', () => {
  expect(completionReceipt({ ...run, status: 'running' }, feedback, 61001)).toBeNull()
  expect(completionReceipt(run, feedback, 1001)).toBeNull()
})
it('preserves model-wrapper completion when the underlying review failed', () => {
  expect(
    completionReceipt({ ...run, response_text: 'Learning analysis exceeded 180 seconds' }, feedback, 61001),
  ).toBeNull()
})
it('rejects unrelated or malformed feedback receipts', () => {
  expect(
    completionReceipt(
      { ...run, response_text: JSON.stringify({ status: 'done', mode: 'daily', batch, feedbackSession: 'other' }) },
      feedback,
      61001,
    ),
  ).toBeNull()
  expect(completionReceipt({ ...run, response_text: '{invalid}' }, feedback, 61001)).toBeNull()
})
