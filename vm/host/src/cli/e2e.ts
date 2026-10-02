// End-to-end check of a throwaway workspace VM built from the current golden image (only read).
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { intFlag, parseArgs, stringFlag } from '../lib/args.ts'
import {
  type ExecResult,
  GUEST_NET,
  type GuestFsReadResult,
  type GuestFsWriteResult,
  type GuestHealth,
  type GuestProcEvent,
  type ProvisionedBot,
  type VmCliCreateResult,
  type VmCliSnapshotResult,
  type VmCliStartResult,
  type VmCliStopResult,
} from '../lib/shared.ts'

const HELP = `usage: node vm/host/src/cli/e2e.ts [--port-base 23900] [--screenshot out.png] [--keep]
env: MILIBOT_E2E_DIR (everything writable; default <tmpdir>/milibot-e2e), MILIBOT_E2E_BOOT_SEC (300; raise
     without KVM/HVF), MILIBOT_E2E_MEM_GB (6)`

const execFileAsync = promisify(execFile)
const VM_CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), 'workspace-vm.ts')
const { flags } = parseArgs(process.argv.slice(2))
if (flags.help) {
  process.stderr.write(HELP + '\n')
  process.exit(0)
}
const ROOT = process.env.MILIBOT_E2E_DIR ?? path.join(os.tmpdir(), 'milibot-e2e')
const BOOT_SEC = process.env.MILIBOT_E2E_BOOT_SEC ?? '300'
const PORT_BASE = intFlag(flags, 'port-base', { fallback: 23900, min: 1024, max: 65000 })
const SHOT = stringFlag(flags, 'screenshot') ?? path.join(ROOT, 'vm-shot.png')
const KEEP = flags.keep === true
const WS = path.join(ROOT, 'ws')

const t0 = Date.now()
const log = (msg: string) => console.log(`[e2e +${((Date.now() - t0) / 1000).toFixed(1)}s] ${msg}`)

async function vm<T>(...cmd: string[]): Promise<T> {
  try {
    const { stdout } = await execFileAsync(process.execPath, [VM_CLI, ...cmd], {
      env: { ...process.env, TMPDIR: ROOT },
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true,
    })
    return JSON.parse(stdout) as T
  } catch (err) {
    const e = err as { stdout?: string; message: string }
    throw new Error(`workspace-vm ${cmd.join(' ')} failed: ${e.stdout || e.message}`, { cause: err })
  }
}

let token = ''

async function request(method: string, route: string, body?: unknown): Promise<Response> {
  return fetch(`http://127.0.0.1:${PORT_BASE}${route}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
}

async function api<T>(method: string, route: string, body?: unknown): Promise<T> {
  const res = await request(method, route, body)
  const json = (await res.json()) as T
  if (!res.ok) throw new Error(`${method} ${route} -> ${res.status} ${JSON.stringify(json)}`)
  return json
}

const guestExec = (body: { user: string; cmd: string; timeoutMs?: number }) =>
  api<ExecResult>('POST', '/exec', body)

function check(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`check failed: ${msg}`)
  log(`ok: ${msg}`)
}

async function streamingCat(): Promise<GuestProcEvent[]> {
  const proc = await api<{ id: string }>('POST', '/procs', { user: 'agent', argv: ['cat'], label: 'e2e-cat' })
  const res = await request('GET', `/procs/${proc.id}/events`)
  if (!res.body) throw new Error('no event stream')
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  const events: GuestProcEvent[] = []
  let buf = ''
  const pump = (async () => {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) return
      buf += decoder.decode(value, { stream: true })
      let i
      while ((i = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, i)
        buf = buf.slice(i + 1)
        if (line) events.push(JSON.parse(line) as GuestProcEvent)
      }
    }
  })()
  await api('POST', `/procs/${proc.id}/stdin`, { data: '{"type":"user","n":1}\n' })
  await api('POST', `/procs/${proc.id}/stdin`, { data: 'second line\n', eof: true })
  await pump
  return events
}

/** gvproxy's network: the guest's address, DNS and HTTPS to the internet, and the host's loopback. */
async function checkNetwork(): Promise<void> {
  const addr = await guestExec({ user: 'agent', cmd: 'ip -4 -o addr show scope global' })
  check(addr.stdout.includes(`${GUEST_NET.guest}/`), `guest has ${GUEST_NET.guest}`)

  const web = await guestExec({
    user: 'agent',
    cmd: "curl -sS -o /dev/null --max-time 30 -w '%{http_code} %{speed_download}' https://deb.debian.org/debian/dists/trixie/main/binary-arm64/Packages.xz",
    timeoutMs: 60000,
  })
  const [status, speed] = web.stdout.trim().split(' ')
  check(
    web.code === 0 && status === '200',
    `DNS and HTTPS to the internet (${(Number(speed) / 1024 ** 2).toFixed(1)} MB/s)`,
  )

  const server = http.createServer((_req, res) => res.end('from-host'))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  try {
    const fromHost = await guestExec({
      user: 'agent',
      cmd: `curl -sS --max-time 10 http://${GUEST_NET.host}:${port}/`,
      timeoutMs: 20000,
    })
    check(fromHost.stdout === 'from-host', `host loopback reachable at ${GUEST_NET.host}`)
  } finally {
    server.close()
  }
}

async function main(): Promise<void> {
  fs.mkdirSync(ROOT, { recursive: true })
  if (fs.existsSync(WS)) {
    await vm('stop', WS, '--force').catch(() => {})
    fs.rmSync(WS, { recursive: true, force: true })
  }

  log('create')
  const created = await vm<VmCliCreateResult>(
    'create',
    WS,
    '--name',
    'e2e',
    '--cpus',
    '4',
    '--mem-gb',
    process.env.MILIBOT_E2E_MEM_GB ?? '6',
    '--data-gb',
    '20',
    '--port-base',
    String(PORT_BASE),
  )
  token = fs.readFileSync(created.tokenFile, 'utf8').trim()

  log('start (first boot)')
  const started = await vm<VmCliStartResult>('start', WS, '--wait', '--timeout-sec', BOOT_SEC)
  log(`first boot: agent ready in ${started.bootMs} ms`)

  const unauth = await fetch(`http://127.0.0.1:${PORT_BASE}/health`)
  check(unauth.status === 401, 'health without token is rejected')
  const health = await api<GuestHealth>('GET', '/health')
  check(
    health.ok && health.dataDiskMounted,
    `health ok, data disk mounted (${health.hostname}, node ${health.node})`,
  )

  await checkNetwork()

  log('provision bot "test" on display :1')
  const bot = await api<ProvisionedBot>('POST', '/bots/provision', { slug: 'test', uid: 1601, display: 1 })
  check(bot.ready, `bot desktop ready (${bot.user} uid ${bot.uid}, vnc ${bot.vncPort})`)
  await new Promise((r) => setTimeout(r, 6000))

  const shot = await api<{ data: string; width: number; height: number }>('POST', '/display/1/screenshot', {})
  fs.writeFileSync(SHOT, Buffer.from(shot.data, 'base64'))
  check(shot.width === 1280 && shot.height === 800, `screenshot is 1280x800 -> ${SHOT}`)

  await api('POST', '/display/1/input', {
    actions: [
      { type: 'move', x: 640, y: 400 },
      { type: 'wait', ms: 50 },
    ],
  })
  log('ok: input actions accepted')

  const versions = await guestExec({
    user: 'agent',
    cmd: 'docker --version; git --version; gh --version | head -1; node -v; python3 --version; go version; claude --version; rustc --version; uv --version; id',
    timeoutMs: 60000,
  })
  console.log(versions.stdout.trim())
  check(versions.code === 0, 'toolchain versions as agent')

  const dockerPs = await guestExec({
    user: 'agent',
    cmd: 'docker info --format "{{.ServerVersion}}"',
    timeoutMs: 60000,
  })
  check(dockerPs.code === 0, `docker daemon reachable by agent (server ${dockerPs.stdout.trim()})`)

  await guestExec({
    user: 'agent',
    cmd: 'mkdir -p /workspace/shared && echo from-agent > /workspace/shared/a.txt',
  })
  const botRw = await guestExec({
    user: 'bot-test',
    cmd: 'cat /workspace/shared/a.txt && echo from-bot >> /workspace/shared/a.txt && echo bot-file > /workspace/shared/b.txt',
  })
  check(botRw.code === 0, 'bot-test reads and appends to a file created by agent')
  const agentRw = await guestExec({
    user: 'agent',
    cmd: 'cat /workspace/shared/a.txt && echo more >> /workspace/shared/b.txt && ls -l /workspace/shared',
  })
  console.log(agentRw.stdout.trim())
  check(
    agentRw.code === 0 && agentRw.stdout.includes('from-bot'),
    'agent appends to a file created by bot-test',
  )

  const written = await api<GuestFsWriteResult>('POST', '/fs/write', {
    path: 'fs-api/hello.txt',
    content: 'hello',
  })
  const read = await api<GuestFsReadResult>('POST', '/fs/read', { path: '/workspace/fs-api/hello.txt' })
  check(read.content === 'hello' && written.gid !== 0, 'fs write/read in /workspace')
  const escape = await request('POST', '/fs/read', { path: '../etc/shadow' })
  check(escape.status === 400, 'fs path traversal rejected')

  const events = await streamingCat()
  const out = events.flatMap((e) => (e.type === 'stdout' ? [e.data] : []))
  const exit = events.find((e) => e.type === 'exit')
  check(
    out[0] === '{"type":"user","n":1}' && out[1] === 'second line' && exit?.code === 0,
    'streaming stdin/stdout via cat',
  )

  await api('POST', '/fs/write', { path: 'marker.txt', content: 'survives-reset' })
  log('stop')
  const stopped = await vm<VmCliStopResult>('stop', WS)
  log(`stopped via ${'method' in stopped ? stopped.method : 'nothing (already stopped)'}`)

  const snap = await vm<VmCliSnapshotResult>('snapshot', 'create', WS, 'before-reset')
  check(
    snap.snapshots.some((s) => s.name === 'before-reset'),
    'snapshot created',
  )

  log('reset-system')
  await vm('reset-system', WS)
  const snapsAfter = await vm<VmCliSnapshotResult>('snapshot', 'list', WS)
  check(snapsAfter.snapshots.length === 0, 'system overlay recreated (snapshots gone)')
  await vm('grow-disk', WS, 'data', '24')

  const restarted = await vm<VmCliStartResult>('start', WS, '--wait', '--timeout-sec', BOOT_SEC)
  log(`boot after reset: agent ready in ${restarted.bootMs} ms`)
  const marker = await api<GuestFsReadResult>('POST', '/fs/read', { path: 'marker.txt' })
  check(marker.content === 'survives-reset', '/workspace survives reset-system')
  const botsAfter = await api<{ bots: unknown[] }>('GET', '/bots')
  check(botsAfter.bots.length === 0, 'bots are gone after reset (daemon re-provisions)')
  const reprov = await api<ProvisionedBot>('POST', '/bots/provision', { slug: 'test', uid: 1601, display: 1 })
  const home = await guestExec({
    user: 'bot-test',
    cmd: 'cat /workspace/shared/b.txt && test -d ~/.config/xfce4 && df -h /data | tail -1',
  })
  check(
    reprov.ready && home.code === 0,
    `re-provisioned bot keeps its home (${home.stdout.trim().split('\n').pop()})`,
  )

  const wrappers = await guestExec({
    user: 'agent',
    cmd: 'for f in claude codex agy gh milibot-browser; do test -x /usr/local/bin/$f || exit 1; done',
  })
  check(wrappers.code === 0, 'guest agent installed the claude, codex, agy, gh and milibot-browser wrappers')

  const final = await vm<VmCliStopResult>('stop', WS)
  log(`final stop via ${'method' in final ? final.method : 'nothing (already stopped)'}`)
  if (!KEEP) fs.rmSync(WS, { recursive: true, force: true })
  log('all checks passed')
}

main().catch(async (err: Error) => {
  console.error(err.message)
  if (!KEEP) await vm('stop', WS, '--force').catch(() => {})
  process.exit(1)
})
