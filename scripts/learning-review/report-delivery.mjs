import { lstat, mkdir, open, realpath } from 'node:fs/promises'
import { constants } from 'node:fs'
import { join } from 'node:path'
import { openCodeErrorStatus } from '../../shared/src/opencode/index.ts'

const VERIFY_ATTEMPTS = 10
const VERIFY_DELAY_MS = 1000
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Report delivery channels: `prompt` posts into the feedback session (which wakes its agent), `file` only stores the report. */
export const DELIVERY_MODES = ['prompt', 'file', 'noReply']

async function deliverFile(config, messageID, report) {
  if (!/^msg_[A-Za-z0-9_]+$/.test(messageID) || (await realpath(config.store)) !== config.store)
    throw new Error('Report path rejected')
  const reviews = join(config.store, 'reviews')
  await mkdir(reviews, { mode: 0o700, recursive: true })
  if ((await realpath(reviews)) !== reviews || !(await lstat(reviews)).isDirectory())
    throw new Error('Report path rejected')
  const folder = join(reviews, 'delivered')
  const path = join(folder, `${messageID}.md`)
  await mkdir(folder, { recursive: true, mode: 0o700 })
  const metadata = await lstat(folder)
  if (
    (await realpath(folder)) !== folder ||
    !metadata.isDirectory() ||
    metadata.uid !== process.getuid() ||
    metadata.mode & 0o077
  )
    throw new Error('Report path rejected')
  let file
  let created = false
  try {
    file = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW, 0o600)
    created = true
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error
    file = await open(path, constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  }
  try {
    const info = await file.stat()
    if (!info.isFile() || info.nlink !== 1 || info.uid !== process.getuid() || info.mode & 0o077)
      throw new Error('Report path rejected')
    if (created) await file.writeFile(report)
    else if ((await file.readFile('utf8')) !== report) throw new Error('Report ID content mismatch')
    await file.sync()
  } finally {
    await file.close()
  }
  const parent = await open(folder, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try {
    await parent.sync()
  } finally {
    await parent.close()
  }
}

async function deliveredText(api, sessionID, messageID) {
  try {
    const message = await api.session.message.get({ sessionID, messageID })
    if (message.type !== 'user' && !(message.type === 'synthetic' && message.metadata?.source === 'manager-report'))
      throw new Error('Report ID content mismatch')
    return message.text
  } catch (error) {
    if (openCodeErrorStatus(error) === 404) return null
    throw error
  }
}

async function deliverPrompt(config, messageID, report, api) {
  const sessionID = config.feedbackSession
  const existing = await deliveredText(api, sessionID, messageID)
  if (existing === report) return
  if (existing !== null) throw new Error('Report ID content mismatch')
  try {
    await api.session.prompt({ sessionID, id: messageID, text: report })
  } catch (error) {
    if (openCodeErrorStatus(error) !== 409) throw error
  }
  for (let attempt = 0; attempt < VERIFY_ATTEMPTS; attempt++) {
    const text = await deliveredText(api, sessionID, messageID)
    if (text === report) return
    if (text !== null) throw new Error('Report ID content mismatch')
    await delay(VERIFY_DELAY_MS)
  }
  throw new Error('Report delivery not verified')
}

/**
 * Delivers `report` exactly once under `messageID`. A retry with the same ID and text is a no-op, and a different text
 * under an already used ID is rejected. `prompt` delivery uses OpenCode 2's durable prompt IDs, and so wakes the
 * feedback session's agent: OpenCode 2 has no inert user message, and unresumed inputs stay queued into the next turn.
 */
export async function publishExactReport(config, messageID, report, api) {
  if (config.delivery === 'noReply') {
    const existing = await deliveredText(api, config.feedbackSession, messageID)
    if (existing === report) return
    if (existing !== null) throw new Error('Report ID content mismatch')
    await api.session.report({
      sessionID: config.feedbackSession,
      messageID,
      text: report,
    })
    if ((await deliveredText(api, config.feedbackSession, messageID)) !== report)
      throw new Error('Report delivery not verified')
    return
  }
  if (config.delivery === 'file') return deliverFile(config, messageID, report)
  if (config.delivery === 'prompt') return deliverPrompt(config, messageID, report, api)
  throw new Error('LEARNING_REVIEW_DELIVERY_UNCONFIGURED')
}
