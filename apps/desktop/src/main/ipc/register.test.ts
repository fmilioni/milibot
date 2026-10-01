import { describe, expect, it, vi } from 'vitest'

import { INVOKE_CHANNELS, SEND_CHANNELS } from '../../bridge/channels'

const registered = new Set<string>()

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => '/tmp', getAppPath: () => '/tmp' },
  BrowserWindow: { fromWebContents: () => null },
  clipboard: {},
  ClipboardItem: class {},
  dialog: {},
  ipcMain: {
    handle: (channel: string) => registered.add(channel),
    on: (channel: string) => registered.add(channel),
  },
  nativeTheme: {},
  screen: {},
  shell: {},
}))

const { registerIpc } = await import('./register')

describe('registerIpc', () => {
  it('registers a handler for every channel of the contract', () => {
    registerIpc({ daemon: {} as never, vncBridge: {} as never, settings: {} as never })
    expect([...registered].sort()).toEqual(
      [...Object.values(INVOKE_CHANNELS), ...Object.values(SEND_CHANNELS)].sort(),
    )
  })
})
