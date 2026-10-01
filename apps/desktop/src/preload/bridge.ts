import {
  allowedChannels,
  EVENT_CHANNELS,
  INVOKE_CHANNELS,
  SEND_CHANNELS,
  type WindowKind,
} from '../bridge/channels'
import type { MilibotBridge } from '../bridge/contract'

export interface PreloadIpc {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>
  send(channel: string, ...args: unknown[]): void
  on(channel: string, listener: (event: unknown, ...args: unknown[]) => void): void
  removeListener(channel: string, listener: (event: unknown, ...args: unknown[]) => void): void
}

export interface PreloadHost {
  kind: WindowKind
  platform: string
  ipc: PreloadIpc
  getPathForFile(file: File): string
}

const eventMethod = (name: string) => `on${name.charAt(0).toUpperCase()}${name.slice(1)}`

/** The channels of the window's kind become methods; the others are left out. */
export function createBridge(host: PreloadHost): MilibotBridge {
  const { ipc } = host
  const allowed: ReadonlySet<string> = allowedChannels(host.kind)
  const bridge: Record<string, unknown> = {
    platform: host.platform,
    windowKind: host.kind,
    getPathForFile: (file: File) => host.getPathForFile(file),
  }
  for (const [name, channel] of Object.entries(INVOKE_CHANNELS)) {
    if (allowed.has(name)) bridge[name] = (...args: unknown[]) => ipc.invoke(channel, ...args)
  }
  for (const [name, channel] of Object.entries(SEND_CHANNELS)) {
    if (allowed.has(name)) bridge[name] = (...args: unknown[]) => ipc.send(channel, ...args)
  }
  for (const [name, channel] of Object.entries(EVENT_CHANNELS)) {
    if (!allowed.has(name)) continue
    bridge[eventMethod(name)] = (listener: (...args: unknown[]) => void) => {
      const handler = (_event: unknown, ...args: unknown[]) => listener(...args)
      ipc.on(channel, handler)
      return () => ipc.removeListener(channel, handler)
    }
  }
  return bridge as MilibotBridge
}
