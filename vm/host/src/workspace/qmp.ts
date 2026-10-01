import net from 'node:net'

import { CliError } from '../lib/args.ts'
import { QMP_TCP_OFFSET, type VmConfigFile, type VmProfile } from '../lib/shared.ts'

export interface QmpReply {
  return?: unknown
  error?: { class?: string; desc?: string }
}

type QmpProfile = Pick<VmProfile, 'qmp'>

/**
 * QMP endpoint: `qmp.sock` in the VM dir on macOS/Linux (unix socket paths are limited to 104/108 bytes,
 * so QEMU runs with cwd=vm/, the CLI enters vm/ too and the socket is addressed relatively), TCP on
 * `portBase + QMP_TCP_OFFSET` on Windows.
 */
export function qmpEndpoint(prof: QmpProfile, config: Pick<VmConfigFile, 'portBase'>): net.NetConnectOpts {
  if (prof.qmp === 'tcp') return { host: '127.0.0.1', port: config.portBase + QMP_TCP_OFFSET }
  return { path: 'qmp.sock' }
}

export function qmpArg(prof: QmpProfile, config: Pick<VmConfigFile, 'portBase'>): string {
  return prof.qmp === 'tcp'
    ? `tcp:127.0.0.1:${config.portBase + QMP_TCP_OFFSET},server=on,wait=off`
    : 'unix:qmp.sock,server=on,wait=off'
}

/** Whether QMP accepts connections (QEMU is up). */
export function qmpReachable(endpoint: net.NetConnectOpts, timeoutMs = 500): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect(endpoint)
    const done = (ok: boolean) => {
      clearTimeout(timer)
      sock.destroy()
      resolve(ok)
    }
    const timer = setTimeout(() => done(false), timeoutMs)
    sock.once('connect', () => done(true))
    sock.once('error', () => done(false))
  })
}

/** Negotiates capabilities, then runs `commands` in order; one reply per command. */
export function qmp(endpoint: net.NetConnectOpts, commands: object[], timeoutMs = 5000): Promise<QmpReply[]> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(endpoint)
    const results: QmpReply[] = []
    let buffer = ''
    let stage = -1
    const timer = setTimeout(() => {
      sock.destroy()
      reject(new CliError('QMP_TIMEOUT', 'QMP did not respond'))
    }, timeoutMs)
    const sendNext = () => {
      stage++
      const cmd = stage === 0 ? { execute: 'qmp_capabilities' } : commands[stage - 1]
      if (!cmd) {
        clearTimeout(timer)
        sock.end()
        resolve(results)
        return
      }
      sock.write(JSON.stringify(cmd) + '\n')
    }
    sock.on('data', (chunk) => {
      buffer += chunk.toString('utf8')
      let idx
      while ((idx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, idx).trim()
        buffer = buffer.slice(idx + 1)
        if (!line) continue
        const msg = JSON.parse(line) as QmpReply & { QMP?: unknown }
        if (msg.QMP) sendNext()
        else if ('return' in msg || 'error' in msg) {
          if (stage > 0) results.push(msg)
          sendNext()
        }
      }
    })
    sock.on('error', (err) => {
      clearTimeout(timer)
      reject(new CliError('QMP_UNAVAILABLE', err.message))
    })
  })
}
