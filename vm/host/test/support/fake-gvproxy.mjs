// Stands in for gvproxy: writes its pid file, waits for one QEMU connection on the config's qemu port and
// exits when it closes; the guest agent's /ping answers on the port forwarded to guest port 8765.
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import path from 'node:path'

process.title = path.basename(process.argv0)

const args = process.argv.slice(2)
const after = (flag) => args[args.indexOf(flag) + 1]
const config = JSON.parse(fs.readFileSync(after('-config'), 'utf8'))
const pidFile = after('-pid-file')
fs.writeFileSync(pidFile, String(process.pid))
fs.writeFileSync(after('-log-file'), 'fake gvproxy\n')

const exit = () => {
  fs.rmSync(pidFile, { force: true })
  process.exit(0)
}
process.on('SIGTERM', exit)
setTimeout(exit, 120_000).unref()

const qemuPort = Number(/:(\d+)$/.exec(config.interfaces.qemu)[1])
const listener = net.createServer((sock) => {
  listener.close()
  sock.on('close', exit)
  sock.on('error', () => {})
})
listener.listen(qemuPort, '127.0.0.1')

const agent = Object.entries(config.stack.forwards).find(([, guest]) => guest.endsWith(':8765'))
if (agent && !process.env.FAKE_GUEST_NO_AGENT) {
  http
    .createServer((req, res) => {
      res.writeHead(req.url === '/ping' ? 200 : 404, { 'content-type': 'application/json' })
      res.end('{"ok":true}')
    })
    .listen(Number(agent[0].split(':')[1]), '127.0.0.1')
}
