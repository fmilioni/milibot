// Runs in the VM (`node -e` as agent; Node 24 has fetch and WebSocket): connects to the Chrome DevTools port
// `CDP_PORT` and relays CDP messages between stdin/stdout, one JSON message per line. `{"relay":"list"}`
// returns the tab list (`/json/list`, most recently active first).
const base = 'http://127.0.0.1:' + process.env.CDP_PORT
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n')
let ws = null
async function main() {
  const version = await (await fetch(base + '/json/version')).json()
  ws = new WebSocket(version.webSocketDebuggerUrl)
  ws.onopen = () => out({ relay: 'open', browser: version.Browser })
  ws.onmessage = (e) => process.stdout.write(String(e.data) + '\n')
  ws.onclose = (e) => {
    out({ relay: 'closed', code: e.code })
    process.exit(0)
  }
  ws.onerror = () => {}
}
require('node:readline')
  .createInterface({ input: process.stdin })
  .on('line', async (line) => {
    if (line.startsWith('{"relay"')) {
      const msg = JSON.parse(line)
      try {
        const list = await (await fetch(base + '/json/list')).json()
        out({ relay: 'list', id: msg.id, list })
      } catch (err) {
        out({ relay: 'list', id: msg.id, error: String((err && err.message) || err) })
      }
      return
    }
    if (ws && ws.readyState === 1) ws.send(line)
  })
  .on('close', () => process.exit(0))
main().catch((err) => {
  out({
    relay: 'error',
    message: String((err && err.cause && err.cause.code) || (err && err.message) || err),
  })
  process.exit(1)
})
