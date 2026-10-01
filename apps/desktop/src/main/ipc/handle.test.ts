import { pathToFileURL } from 'node:url'

import { beforeAll, describe, expect, it, vi } from 'vitest'

import { INVOKE_CHANNELS, SEND_CHANNELS } from '../../bridge/channels'
import { registerWindow } from '../windows/registry'
import { rendererLocation } from '../windows/trust'
import type { WindowKind } from '../windows/types'

type Listener = (event: unknown, ...args: unknown[]) => unknown
const registered = new Map<string, Listener>()

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: Listener) => registered.set(channel, fn),
    on: (channel: string, fn: Listener) => registered.set(channel, fn),
  },
}))

const { handle, listen } = await import('./handle')

const WORKSPACE_WINDOW = 11
const VM_WINDOW = 12
const appUrl = `${pathToFileURL(rendererLocation().indexFile).href}#/vm?bot=b1`

function event(options: { id?: number; url?: string; top?: boolean } = {}) {
  const frame = { url: options.url ?? appUrl, parent: options.top === false ? {} : null }
  return { sender: { id: options.id ?? WORKSPACE_WINDOW }, senderFrame: frame }
}

function register(id: number, kind: WindowKind) {
  const window = { webContents: { id }, on: () => undefined }
  registerWindow({ kind, window: window as never, workspaceId: 'ws_1', key: `ws_1:${id}` })
}

beforeAll(() => {
  register(WORKSPACE_WINDOW, 'workspace')
  register(VM_WINDOW, 'vm')
})

describe('IPC argument checks', () => {
  it('passes the parsed arguments to an invoke handler and rejects bad ones', () => {
    handle('setWindowWorkspace', (_event, [workspaceId, title]) => void `${workspaceId}${title}`)
    handle('setLoginItem', (_event, [enabled]) => !enabled)
    const invoke = registered.get(INVOKE_CHANNELS.setLoginItem)!
    expect(invoke(event(), true)).toBe(false)
    expect(() => invoke(event(), 'yes')).toThrow(`Invalid arguments for ${INVOKE_CHANNELS.setLoginItem}`)
  })

  it('drops one-way messages with bad arguments', () => {
    const received: Array<string | null> = []
    listen('setActiveConversation', (_event, [conversationId]) => received.push(conversationId))
    const send = registered.get(SEND_CHANNELS.setActiveConversation)!
    send(event(), 'c1')
    send(event(), 42)
    expect(received).toEqual(['c1', null])

    const colors: unknown[] = []
    listen('setTitleBarOverlay', (_event, [value]) => colors.push(value))
    registered.get(SEND_CHANNELS.setTitleBarOverlay)!(event(), { color: 'url(x)', symbolColor: 'red' })
    expect(colors).toEqual([])
  })
})

describe('IPC sender checks', () => {
  it('refuses invokes from unknown windows, subframes and foreign pages', () => {
    handle('readClipboard', () => 'text')
    const invoke = registered.get(INVOKE_CHANNELS.readClipboard)!
    expect(invoke(event())).toBe('text')
    expect(() => invoke(event({ id: 99 }))).toThrow(`Untrusted sender for ${INVOKE_CHANNELS.readClipboard}`)
    expect(() => invoke(event({ top: false }))).toThrow('Untrusted sender')
    expect(() => invoke(event({ url: 'https://evil.example/' }))).toThrow('Untrusted sender')
    expect(() => invoke({ sender: { id: WORKSPACE_WINDOW }, senderFrame: null })).toThrow('Untrusted sender')
  })

  it('refuses channels the window kind does not use', () => {
    handle('revealPath', () => undefined)
    const reveal = registered.get(INVOKE_CHANNELS.revealPath)!
    expect(reveal(event(), '/tmp/x')).toBeUndefined()
    expect(() => reveal(event({ id: VM_WINDOW }), '/tmp/x')).toThrow('Untrusted sender')
    expect(registered.get(INVOKE_CHANNELS.readClipboard)!(event({ id: VM_WINDOW }))).toBe('text')
  })

  it('drops one-way messages from foreign pages', () => {
    const received: Array<string | null> = []
    listen('reportRendererError', (_event, [report]) => received.push(report.message))
    const send = registered.get(SEND_CHANNELS.reportRendererError)!
    send(event({ url: 'file:///tmp/other.html' }), { source: 'error', message: 'nope' })
    send(event(), { source: 'error', message: 'yes' })
    expect(received).toEqual(['yes'])
  })
})
