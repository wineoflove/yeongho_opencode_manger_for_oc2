import { expect, it } from 'bun:test'
import { freshKey, maxAgeMs, messageIdFor, publishReport, reportedAfter } from './publish.mjs'

const config = { feedbackSession: 'ses_report', directory: '/assistant', store: '/unused', delivery: 'prompt' }
const now = Date.parse('2026-10-04T09:00:00Z')
const result = {
  checkedAt: new Date(now - 1000).toISOString(),
  hasFresh: true,
  components: [
    { id: 'oc', pending: [{ version: '1.18.34' }, { version: '2.0.22' }], fresh: ['2.0.22'] },
    { id: 'ocm', error: 'gh failed' },
    { id: 'omo', pending: [{ version: '5.1.15' }], fresh: ['5.1.15'] },
    { id: 'headroom', pending: [{ version: '0.42.0' }], fresh: ['0.42.0'] },
  ],
}

function session(deliver = true) {
  const messages = []
  const calls = []
  const request = {
    session: {
      prompt: async ({ sessionID, id, text }) => {
        calls.push({ sessionID, id, text })
        if (deliver) messages.push({ id, type: 'user', text })
      },
      message: {
        get: async ({ messageID }) => {
          const message = messages.find((entry) => entry.id === messageID)
          if (!message) throw Object.assign(new Error('missing'), { _tag: 'MessageNotFoundError' })
          return message
        },
      },
    },
  }
  return { messages, calls, request }
}

function recorder() {
  const saved = []
  return {
    saved,
    save: async (state) => {
      saved.push(structuredClone(state))
    },
  }
}

it('derives a stable key from unreported versions and a sortable message ID', () => {
  expect(freshKey(result)).toBe(freshKey(structuredClone(result)))
  expect(freshKey({ ...result, components: [result.components[0]] })).not.toBe(freshKey(result))
  expect(messageIdFor('a'.repeat(64), now)).toMatch(/^msg_[0-9a-f]{12}a{14}$/)
})

it('keeps the previous reported list for a component whose collection failed', () => {
  expect(reportedAfter({ reported: { ocm: ['0.19.0'], oc: ['1.18.34'] } }, result)).toEqual({
    ocm: ['0.19.0'],
    oc: ['1.18.34', '2.0.22'],
    omo: ['5.1.15'],
    headroom: ['0.42.0'],
  })
})

it('rejects stale, empty, oversized, and nothing-new inputs before any write', async () => {
  const { saved, save } = recorder()
  const base = { config, state: { reported: {} }, result, report: 'r', now, save, request: session().request }
  await expect(publishReport({ ...base, result: { ...result, hasFresh: false } })).rejects.toThrow('No unreported')
  await expect(publishReport({ ...base, now: now + maxAgeMs + 1000 })).rejects.toThrow('stale')
  await expect(publishReport({ ...base, report: '  ' })).rejects.toThrow('characters')
  await expect(publishReport({ ...base, report: 'x'.repeat(40001) })).rejects.toThrow('characters')
  expect(saved).toEqual([])
})

it('persists the pending report before posting and marks versions reported only after verification', async () => {
  const { saved, save } = recorder()
  const { messages, request } = session()
  const output = await publishReport({
    config,
    state: { reported: {} },
    result,
    report: '## 보고서\n',
    now,
    save,
    request,
  })
  expect(saved[0].pending).toEqual({ key: freshKey(result), messageID: output.messageID, report: '## 보고서' })
  expect(messages).toHaveLength(1)
  expect(messages[0].text).toBe('## 보고서')
  expect(saved[1]).toEqual({
    reported: reportedAfter({ reported: {} }, result),
    lastReport: {
      key: freshKey(result),
      messageID: output.messageID,
      session: 'ses_report',
      at: new Date(now).toISOString(),
    },
  })
})

it('leaves versions unreported when delivery cannot be verified', async () => {
  const { saved, save } = recorder()
  const original = globalThis.setTimeout
  globalThis.setTimeout = (callback) => original(callback, 0)
  try {
    await expect(
      publishReport({ config, state: { reported: {} }, result, report: 'r', now, save, request: session(false).request }),
    ).rejects.toThrow('not verified')
  } finally {
    globalThis.setTimeout = original
  }
  expect(saved).toHaveLength(1)
  expect(saved[0].reported).toEqual({})
})

it('retries with the stored pending message so a delivered report is never duplicated', async () => {
  const pending = { key: freshKey(result), messageID: messageIdFor(freshKey(result), now - 60000), report: 'first' }
  const { messages, calls, request } = session()
  messages.push({ id: pending.messageID, type: 'user', text: 'first' })
  const { save } = recorder()
  const output = await publishReport({
    config,
    state: { reported: {}, pending },
    result,
    report: 'second',
    now,
    save,
    request,
  })
  expect(output).toMatchObject({ reusedPending: true, messageID: pending.messageID })
  expect(calls).toHaveLength(0)
  expect(messages).toHaveLength(1)
})
