import { constants } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { open, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { durableTransferRecord } from './claude-transfer-activate'

export class OpenAiStagePublicationError extends Error {
  readonly code = 'LEDGER_DURABILITY_UNCONFIRMED'
  readonly published = true
  constructor() {
    super('LEDGER_DURABILITY_UNCONFIRMED')
    this.name = 'OpenAiStagePublicationError'
  }
}

export async function publishOpenAiStageLedger(directory: string, ledger: unknown): Promise<void> {
  const pending = join(directory, `ledger.pending-${randomUUID()}.json`)
  await durableTransferRecord(pending, ledger)
  await rename(pending, join(directory, 'ledger.json'))
  try {
    const parent = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
    try {
      await parent.sync()
    } finally {
      await parent.close()
    }
  } catch {
    throw new OpenAiStagePublicationError()
  }
}
