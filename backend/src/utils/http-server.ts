import { serve } from '@hono/node-server'
import { createNodeWebSocket } from '@hono/node-ws'
import type { Hono } from 'hono'
import { WSContext, type UpgradeWebSocket } from 'hono/ws'

const bunAdapter = typeof Bun !== 'undefined' ? await import('hono/bun') : undefined

export interface HttpServerHandle {
  readonly port: number
  close(): Promise<void>
}

export interface HttpServerRuntime {
  readonly upgradeWebSocket: UpgradeWebSocket
  start(options: {
    readonly port: number
    readonly hostname: string
    readonly onError?: (error: Error) => void
  }): Promise<HttpServerHandle>
}

export function createHttpServer(app: Hono): HttpServerRuntime {
  if (bunAdapter) {
    const { upgradeWebSocket, websocket } = bunAdapter
    return {
      upgradeWebSocket,
      async start(options) {
        const server = Bun.serve({
          ...options,
          idleTimeout: 0,
          maxRequestBodySize: Number.MAX_SAFE_INTEGER,
          fetch: (request, server) => app.fetch(request, { server }),
          websocket: {
            ...websocket,
            idleTimeout: 0,
            open(ws) {
              ws.data.events.onOpen?.(
                new Event('open'),
                new WSContext({
                  raw: {
                    get bufferedAmount() {
                      return ws.getBufferedAmount()
                    },
                  },
                  send: (data, options) => {
                    ws.send(data, options?.compress)
                  },
                  close: (code, reason) => ws.close(code, reason),
                  readyState: ws.readyState,
                  url: ws.data.url,
                  protocol: ws.data.protocol,
                }),
              )
            },
            message(ws, message) {
              websocket.message(ws, typeof message === 'string' ? message : { buffer: new Uint8Array(message).buffer })
            },
          },
        })
        return {
          port: Number(server.url.port),
          close: async () => {
            await server.stop(true)
          },
        }
      },
    }
  }

  const node = createNodeWebSocket({ app })
  return {
    upgradeWebSocket: node.upgradeWebSocket,
    start: (options) =>
      new Promise((resolve, reject) => {
        const server = serve({ ...options, fetch: app.fetch }, (address) => {
          server.off('error', reject)
          if (options.onError) server.on('error', options.onError)
          resolve({
            port: address.port,
            close: () =>
              new Promise<void>((resolve, reject) => {
                for (const client of node.wss.clients) client.terminate()
                node.wss.close()
                server.close((error) => (error ? reject(error) : resolve()))
              }),
          })
        })
        server.once('error', reject)
        node.injectWebSocket(server)
      }),
  }
}
