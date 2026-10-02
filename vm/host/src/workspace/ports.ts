import { portFree } from '../lib/net.ts'
import {
  NET_TCP_OFFSET,
  QMP_TCP_OFFSET,
  type VmCliPorts,
  type VmConfigFile,
  type VmProfile,
  VNC_DISPLAYS,
} from '../lib/shared.ts'

type PortProfile = Pick<VmProfile, 'qmp'>

/**
 * Host ports a running VM binds: the agent, one per VNC display, QMP on Windows and gvproxy's port for
 * QEMU (the last one, so the range is the same on every host).
 */
export function requiredPorts(portBase: number, prof: PortProfile): number[] {
  const ports: number[] = []
  for (let offset = 0; offset <= NET_TCP_OFFSET; offset++) {
    if (offset === QMP_TCP_OFFSET && prof.qmp !== 'tcp') continue
    ports.push(portBase + offset)
  }
  return ports
}

/** Highest port base whose whole range stays below 65536 (checked by `create` and `resize`). */
export function maxPortBase(): number {
  return 65535 - NET_TCP_OFFSET
}

export const MIN_PORT_BASE = 1024

export async function busyPorts(portBase: number, prof: PortProfile): Promise<number[]> {
  const busy: number[] = []
  for (const port of requiredPorts(portBase, prof)) {
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
