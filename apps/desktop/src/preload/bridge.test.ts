import { describe, expect, it } from 'vitest'

import { allowedChannels, EVENT_CHANNELS, INVOKE_CHANNELS, SEND_CHANNELS } from '../bridge/channels'
import { createBridge, type PreloadIpc } from './bridge'

function fakeIpc() {
  const calls: Array<{ kind: string; channel: string; args: unknown[] }> = []
  const listeners = new Map<string, (event: unknown, ...args: unknown[]) => void>()
  const ipc: PreloadIpc = {
    invoke: async (channel, ...args) => {
      calls.push({ kind: 'invoke', channel, args })
      return null
    },
    send: (channel, ...args) => void calls.push({ kind: 'send', channel, args }),
    on: (channel, listener) => void listeners.set(channel, listener),
    removeListener: (channel) => void listeners.delete(channel),
  }
  return { ipc, calls, listeners }
}

const host = (kind: 'workspace' | 'canvas' | 'vm', ipc: PreloadIpc) => ({
  kind,
  platform: 'darwin',
  ipc,
  getPathForFile: () => '/tmp/file',
})

describe('preload bridge', () => {
  it('gives the workspace window a method for every channel', () => {
    const { ipc, calls } = fakeIpc()
    const bridge = createBridge(host('workspace', ipc)) as unknown as Record<string, unknown>
    for (const name of [...Object.keys(INVOKE_CHANNELS), ...Object.keys(SEND_CHANNELS)])
      expect(typeof bridge[name], name).toBe('function')
    expect(typeof bridge.onShowConversation).toBe('function')
    expect(bridge.windowKind).toBe('workspace')

    void (bridge.setWindowWorkspace as (...args: unknown[]) => Promise<unknown>)('ws_1', 'Personal')
    ;(bridge.setActiveConversation as (id: string) => void)('c1')
    expect(calls).toEqual([
      { kind: 'invoke', channel: INVOKE_CHANNELS.setWindowWorkspace, args: ['ws_1', 'Personal'] },
      { kind: 'send', channel: SEND_CHANNELS.setActiveConversation, args: ['c1'] },
    ])
  })

  it('leaves out what the window kind may not use', () => {
    const { ipc } = fakeIpc()
    for (const kind of ['canvas', 'vm'] as const) {
      const bridge = createBridge(host(kind, ipc)) as unknown as Record<string, unknown>
      const allowed = allowedChannels(kind)
      for (const name of [...Object.keys(INVOKE_CHANNELS), ...Object.keys(SEND_CHANNELS)])
        expect(name in bridge, `${kind}.${name}`).toBe(allowed.has(name as never))
    }
    expect('openVnc' in createBridge(host('vm', ipc))).toBe(true)
  })

  it('subscribes to main-process events and unsubscribes', () => {
    const { ipc, listeners } = fakeIpc()
    const bridge = createBridge(host('workspace', ipc))
    const seen: string[][] = []
    const off = bridge.onShowConversation((workspaceId, conversationId) =>
      seen.push([workspaceId, conversationId]),
    )
    listeners.get(EVENT_CHANNELS.showConversation)?.({}, 'ws_1', 'c1')
    off()
    expect(seen).toEqual([['ws_1', 'c1']])
    expect(listeners.has(EVENT_CHANNELS.showConversation)).toBe(false)
  })

  it("relays the app's update state and the install request", () => {
    const { ipc, calls, listeners } = fakeIpc()
    const bridge = createBridge(host('workspace', ipc))
    const seen: unknown[] = []
    const off = bridge.onAppUpdateChanged((state) => seen.push(state))
    listeners.get(EVENT_CHANNELS.appUpdateChanged)?.({}, { status: 'ready', version: '0.5.0' })
    off()
    expect(seen).toEqual([{ status: 'ready', version: '0.5.0' }])
    void bridge.installAppUpdate()
    expect(calls).toEqual([{ kind: 'invoke', channel: INVOKE_CHANNELS.installAppUpdate, args: [] }])
    expect('onAppUpdateChanged' in createBridge(host('canvas', ipc))).toBe(false)
  })
})
