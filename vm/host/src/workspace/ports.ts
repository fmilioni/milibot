import net from 'node:net'

import {
  QMP_TCP_OFFSET,
  type VmCliPorts,
  type VmConfigFile,
  type VmProfile,
  VNC_DISPLAYS,
} from '../lib/shared.ts'

type PortProfile = Pick<VmProfile, 'qmp'>

/** Ports after the base a running VM binds: one per VNC display and, on Windows, QMP. */
function portSpan(prof: PortProfile): number {
  return prof.qmp === 'tcp' ? QMP_TCP_OFFSET : VNC_DISPLAYS
}

/** Host ports a running VM binds: the agent, one per VNC display and, on Windows, QMP. */
export function requiredPorts(portBase: number, prof: PortProfile): { first: number; last: number } {
  return { first: portBase, last: portBase + portSpan(prof) }
}

/** Highest port base whose whole range stays below 65536 (checked by `create` and `resize`). */
export function maxPortBase(prof: PortProfile): number {
  return 65535 - portSpan(prof)
}

export const MIN_PORT_BASE = 1024

function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer()
    srv.once('error', () => resolve(false))
    srv.listen({ host: '127.0.0.1', port, exclusive: true }, () => srv.close(() => resolve(true)))
  })
}

export async function busyPorts(portBase: number, prof: PortProfile): Promise<number[]> {
  const { first, last } = requiredPorts(portBase, prof)
  const busy: number[] = []
  for (let port = first; port <= last; port++) {
    if (!(await portFree(port))) busy.push(port)
  }
  return busy
}

export async function agentPing(port: number, timeoutMs = 1500): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/ping`, { signal: AbortSignal.timeout(timeoutMs) })
    return res.ok
  } catch {
    return false
  }
}

export function portsOf(config: Pick<VmConfigFile, 'portBase'>): VmCliPorts {
  return {
    agent: config.portBase,
    vncFirst: config.portBase + 1,
    vncLast: config.portBase + VNC_DISPLAYS,
    vncForDisplay: `portBase + display (display 1..${VNC_DISPLAYS})`,
  }
}
