// Sends an LSP initialize request to a language server over stdio and prints its capabilities.
//   node lsp-check.mjs <server executable> <project root>     (TSSERVER=<tsserver.js> optional)
import { spawn } from 'node:child_process'
import { resolve } from 'node:path'

const [server, root = process.cwd()] = process.argv.slice(2)
if (!server) {
  console.error('usage: node lsp-check.mjs <server executable> <project root>')
  process.exit(2)
}

const child = spawn(server, ['--stdio'], { stdio: ['pipe', 'pipe', 'inherit'] })
const send = (message) => {
  const body = JSON.stringify({ jsonrpc: '2.0', ...message })
  child.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`)
}
const fail = (reason) => {
  console.error(`LSP check failed: ${reason}`)
  child.kill()
  process.exit(1)
}
const timer = setTimeout(() => fail('initialize timed out after 20s'), 20000)
child.on('error', (error) => fail(error.message))
child.on('exit', (code) => code && fail(`server exited with ${code}`))

let buffer = Buffer.alloc(0)
child.stdout.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk])
  for (;;) {
    const separator = buffer.indexOf('\r\n\r\n')
    if (separator < 0) return
    const length = Number(/Content-Length: (\d+)/i.exec(buffer.subarray(0, separator).toString())?.[1])
    if (buffer.length < separator + 4 + length) return
    const message = JSON.parse(buffer.subarray(separator + 4, separator + 4 + length).toString())
    buffer = buffer.subarray(separator + 4 + length)
    if (message.id === 1) {
      if (message.error) fail(message.error.message)
      const capabilities = Object.keys(message.result?.capabilities ?? {})
      console.log(
        `initialize ok: ${capabilities.length} capabilities ` +
          `(hover=${capabilities.includes('hoverProvider')}, definition=${capabilities.includes('definitionProvider')})`,
      )
      send({ id: 2, method: 'shutdown' })
    } else if (message.id === 2) {
      send({ method: 'exit' })
      clearTimeout(timer)
      setTimeout(() => process.exit(0), 200)
    }
  }
})

send({
  id: 1,
  method: 'initialize',
  params: {
    processId: process.pid,
    rootUri: `file://${resolve(root)}`,
    capabilities: {},
    initializationOptions: process.env.TSSERVER ? { tsserver: { fallbackPath: process.env.TSSERVER } } : {},
  },
})
