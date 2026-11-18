import { chmodSync, closeSync, existsSync, openSync } from 'node:fs'
import { Worker } from 'node:worker_threads'
import { z } from 'zod'
import { MessageSearchResponseSchema, type MessageSearchQuery } from '@opencode-manager/shared/schemas'
import { MessageSearchEngine, type MessageSearchOptions } from './message-search-engine'
import { runMessageSearchWorker, type SearchWorkerRequest } from './message-search-worker'
import { logger } from '../utils/logger'

const ReplySchema = z.object({
  id: z.number().int().optional(),
  result: z.unknown().optional(),
  error: z.string().optional(),
})

const INDEX_FILE_SUFFIXES = ['', '-wal', '-shm'] as const

function restrictIndexFiles(indexPath: string): void {
  closeSync(openSync(indexPath, 'a', 0o600))
  for (const suffix of INDEX_FILE_SUFFIXES) {
    if (existsSync(indexPath + suffix)) chmodSync(indexPath + suffix, 0o600)
  }
}

export class MessageSearchUnavailable extends Error {
  constructor() {
    super('Message search unavailable')
    this.name = 'MessageSearchUnavailable'
  }
}

export class MessageSearchService {
  private readonly failedWorkers = new WeakSet<Worker>()
  private worker: Worker | undefined
  private sequence = 0
  private closing = false
  private readonly pending = new Map<
    number,
    {
      readonly resolve: (value: unknown) => void
      readonly reject: (error: Error) => void
    }
  >()

  constructor(private readonly options: MessageSearchOptions) {}

  private start(): Worker {
    if (this.closing) throw new MessageSearchUnavailable()
    if (this.worker) return this.worker
    try {
      restrictIndexFiles(this.options.indexPath)
    } catch (error) {
      logger.error('Message search index permissions could not be restricted', error)
      throw new MessageSearchUnavailable()
    }
    const worker = new Worker(`(${runMessageSearchWorker.toString()})(${MessageSearchEngine.toString()})`, {
      eval: true,
      workerData: this.options,
    })
    this.worker = worker
    worker.on('message', (value: unknown) => {
      const parsed = ReplySchema.safeParse(value)
      if (!parsed.success || parsed.data.id === undefined) {
        logger.warn('Message search worker reported an indexing error')
        return
      }
      const reply = parsed.data
      const request = this.pending.get(parsed.data.id)
      this.pending.delete(parsed.data.id)
      if (reply.error) request?.reject(new MessageSearchUnavailable())
      else request?.resolve(reply.result)
    })
    worker.on('error', () => {
      this.failedWorkers.add(worker)
      logger.error('Message search worker failed')
      for (const request of this.pending.values()) request.reject(new MessageSearchUnavailable())
      this.pending.clear()
    })
    worker.on('exit', () => {
      this.failedWorkers.add(worker)
      if (this.worker === worker) this.worker = undefined
      for (const request of this.pending.values()) request.reject(new MessageSearchUnavailable())
      this.pending.clear()
    })
    return worker
  }

  private request(worker: Worker, request: SearchWorkerRequest): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(request.id)
        reject(new MessageSearchUnavailable())
      }, 15000)
      this.pending.set(request.id, {
        resolve: (value) => {
          clearTimeout(timer)
          resolve(value)
        },
        reject: (error) => {
          clearTimeout(timer)
          reject(error)
        },
      })
      try {
        worker.postMessage(request)
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(request.id)
        reject(error)
      }
    })
  }

  async search(query: MessageSearchQuery) {
    return MessageSearchResponseSchema.parse(
      await this.request(this.start(), {
        id: ++this.sequence,
        kind: 'search',
        query,
      }),
    )
  }

  async stop(): Promise<void> {
    this.closing = true
    const worker = this.worker
    if (!worker) return
    try {
      if (!this.failedWorkers.has(worker)) {
        await this.request(worker, { id: ++this.sequence, kind: 'close' })
      }
    } catch (error) {
      if (!(error instanceof MessageSearchUnavailable && this.failedWorkers.has(worker))) throw error
    } finally {
      await worker.terminate()
      if (this.worker === worker) this.worker = undefined
    }
  }
}
