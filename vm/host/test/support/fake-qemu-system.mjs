// Stands in for qemu-system-*: writes its pid file, answers QMP and the guest agent's /ping, exits on
// system_powerdown or quit. Records its arguments in fake-qemu-args.json in its cwd (the VM dir).
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import path from 'node:path'

// Node names its main thread MainThread, which is what Linux shows as the process name (/proc/<pid>/comm).
process.title = path.basename(process.argv0)

const args = process.argv.slice(2)
const after = (flag) => args[args.indexOf(flag) + 1]
fs.writeFileSync('fake-qemu-args.json', JSON.stringify(args))
fs.writeFileSync(after('-pidfile'), String(process.pid))

const exitSoon = () => setTimeout(() => process.exit(0), 50)
setTimeout(() => process.exit(3), 120_000).unref()

const qmpArg = after('-qmp')
const unix = /^unix:([^,]+)/.exec(qmpArg)
const tcp = /^tcp:127\.0\.0\.1:(\d+)/.exec(qmpArg)
const qmp = net.createServer((sock) => {
  sock.write(JSON.stringify({ QMP: { version: {}, capabilities: [] } }) + '\n')
  let buffer = ''
  sock.on('data', (chunk) => {
    buffer += chunk
    let idx
    while ((idx = buffer.indexOf('\n')) !== -1) {
      const cmd = JSON.parse(buffer.slice(0, idx))
      buffer = buffer.slice(idx + 1)
      const reply = (value) => sock.write(JSON.stringify({ return: value }) + '\n')
      switch (cmd.execute) {
        case 'query-status':
          reply({ status: 'running', running: true })
          break
        case 'query-block':
          reply([])
          break
        case 'system_powerdown':
        case 'quit':
          reply({})
          exitSoon()
          break
        default:
          reply({})
      }
    }
  })
  sock.on('error', () => {})
})
if (unix) qmp.listen(unix[1])
else if (tcp) qmp.listen(Number(tcp[1]), '127.0.0.1')

const agentPort = /hostfwd=tcp:127\.0\.0\.1:(\d+)-:/.exec(after('-netdev'))?.[1]
if (agentPort && !process.env.FAKE_QEMU_NO_AGENT) {
  http
    .createServer((req, res) => {
      res.writeHead(req.url === '/ping' ? 200 : 404, { 'content-type': 'application/json' })
      res.end('{"ok":true}')
    })
    .listen(Number(agentPort), '127.0.0.1')
}
