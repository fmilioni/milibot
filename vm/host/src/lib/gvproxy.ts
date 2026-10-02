// gvproxy: the VM's network (DHCP, DNS, NAT to the internet and the host's loopback, forwarded host ports),
// a user-space stack QEMU reaches through `-netdev stream`. It accepts a single QEMU connection and exits
// when that connection closes, so it is started before every QEMU launch.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import { CliError } from './args.ts'
import { sleep } from './host.ts'
import { portFree } from './net.ts'
import { gvproxyIdentity, pidAlive, readPidFile } from './proc.ts'
import { executableName, GUEST_NET } from './shared.ts'

const GVPROXY_ENV = 'MILIBOT_GVPROXY'

/** `MILIBOT_GVPROXY`, else `bin/gvproxy` in the `vm/` folder (fetched by `pnpm vm:tools`, bundled in the app). */
export function gvproxyBinary(vmRoot: string, env: NodeJS.ProcessEnv = process.env): string {
  return env[GVPROXY_ENV] || path.join(vmRoot, 'bin', executableName('gvproxy', process.platform))
}

export interface GvproxyFiles {
  config: string
  pid: string
  log: string
}

export function gvproxyFiles(dir: string): GvproxyFiles {
  return {
    config: path.join(dir, 'gvproxy.json'),
    pid: path.join(dir, 'gvproxy.pid'),
    log: path.join(dir, 'gvproxy.log'),
  }
}

export interface GvproxyNetwork {
  /** Loopback port gvproxy listens on for QEMU. */
  qemuPort: number
  /** The guest NIC's MAC: DHCP always gives it `GUEST_NET.guest`. */
  mac: string
  /** `[host loopback port, guest port]` pairs. */
  forwards?: [number, number][]
}

/** gvproxy's `-config` file (JSON is YAML). Without `forwards` it forwards nothing (no default SSH port). */
export function gvproxyConfig(network: GvproxyNetwork): object {
  return {
    'log-level': 'info',
    interfaces: { qemu: `tcp://127.0.0.1:${network.qemuPort}` },
    stack: {
      mtu: 1500,
      subnet: GUEST_NET.subnet,
      gatewayIP: GUEST_NET.gateway,
      forwards: Object.fromEntries(
        (network.forwards ?? []).map(([host, guest]) => [`127.0.0.1:${host}`, `${GUEST_NET.guest}:${guest}`]),
      ),
      nat: { [GUEST_NET.host]: '127.0.0.1' },
      gatewayVirtualIPs: [GUEST_NET.host],
      dhcpStaticLeases: { [GUEST_NET.guest]: network.mac.toLowerCase() },
    },
  }
}

/** QEMU's side of the link: the value of `-netdev`. */
export function streamNetdev(id: string, qemuPort: number): string {
  return `stream,id=${id},server=off,addr.type=inet,addr.host=127.0.0.1,addr.port=${qemuPort}`
}

function logTail(file: string): string {
  try {
    return fs.readFileSync(file, 'utf8').trim().split('\n').slice(-5).join('\n')
  } catch {
    return ''
  }
}

/** Stops the gvproxy of a pid file (left by a QEMU that died, or a launch that failed). */
export async function stopGvproxy(files: Pick<GvproxyFiles, 'pid'>, graceMs = 2000): Promise<void> {
  const pid = readPidFile(files.pid)
  if (pid && gvproxyIdentity(pid) === 'yes') {
    process.kill(pid, 'SIGTERM')
    const deadline = Date.now() + graceMs
    while (pidAlive(pid) && Date.now() < deadline) await sleep(50)
    if (pidAlive(pid) && gvproxyIdentity(pid) === 'yes') process.kill(pid, 'SIGKILL')
  }
  fs.rmSync(files.pid, { force: true })
}

/**
 * Starts a detached gvproxy for one QEMU launch and waits until it listens for QEMU. Readiness is checked by
 * binding the port, never by connecting: gvproxy takes the first connection as the VM's.
 */
export async function startGvproxy(
  binary: string,
  files: GvproxyFiles,
  network: GvproxyNetwork,
  timeoutMs = 10_000,
): Promise<number> {
  if (!fs.existsSync(binary)) throw new CliError('GVPROXY_MISSING', `gvproxy not found at ${binary}`)
  await stopGvproxy(files)
  fs.writeFileSync(files.config, JSON.stringify(gvproxyConfig(network), null, 2) + '\n')
  fs.rmSync(files.log, { force: true })
  const child = spawn(binary, ['-config', files.config, '-log-file', files.log, '-pid-file', files.pid], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  })
  let exited: string | null = null
  child.on('exit', (code, signal) => (exited = `exited (${signal ?? `code ${code}`})`))
  child.on('error', (err) => (exited = err.message))
  child.unref()
  const deadline = Date.now() + timeoutMs
  while (await portFree(network.qemuPort)) {
    if (exited || Date.now() > deadline) {
      if (!exited) child.kill('SIGKILL')
      fs.rmSync(files.pid, { force: true })
      const why = logTail(files.log) || exited || 'not listening in time'
      throw new CliError('NETWORK_START_FAILED', `gvproxy failed to start: ${why}`)
    }
    await sleep(50)
  }
  return child.pid ?? 0
}
