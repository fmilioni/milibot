import { describe, expect, it } from 'vitest'

import {
  allowedChannels,
  EVENT_CHANNELS,
  INVOKE_CHANNELS,
  SEND_CHANNELS,
  windowKindFromArgv,
} from './channels'
import { DesignExportFrame, events, invokes, sends, TitleBarColors } from './contract'

describe('IPC contract', () => {
  it('has one entry per channel, each with its own channel name', () => {
    expect(Object.keys(invokes).sort()).toEqual(Object.keys(INVOKE_CHANNELS).sort())
    expect(Object.keys(sends).sort()).toEqual(Object.keys(SEND_CHANNELS).sort())
    expect(Object.keys(events).sort()).toEqual(Object.keys(EVENT_CHANNELS).sort())
    const channels = [...Object.values(invokes), ...Object.values(sends), ...Object.values(events)].map(
      (entry) => entry.channel,
    )
    expect(new Set(channels).size).toBe(channels.length)
    expect(invokes.openVnc).toMatchObject({ name: 'openVnc', channel: INVOKE_CHANNELS.openVnc })
  })

  it('gives the VM window only what its screen needs', () => {
    const vm = allowedChannels('vm')
    expect(vm.has('openVnc')).toBe(true)
    expect(vm.has('revealPath')).toBe(false)
    expect(vm.has('showConversation')).toBe(false)
    expect(allowedChannels('canvas').has('exportDesignPng')).toBe(true)
    expect(allowedChannels('canvas').has('setLoginItem')).toBe(false)
    expect(allowedChannels('workspace').size).toBe(
      Object.keys({ ...INVOKE_CHANNELS, ...SEND_CHANNELS, ...EVENT_CHANNELS }).length,
    )
  })

  it("keeps the app's update in the workspace windows only", () => {
    for (const name of ['getAppUpdate', 'installAppUpdate', 'appUpdateChanged'] as const) {
      expect(allowedChannels('workspace').has(name), name).toBe(true)
      expect(allowedChannels('canvas').has(name), name).toBe(false)
      expect(allowedChannels('vm').has(name), name).toBe(false)
    }
  })

  it('reads the window kind the main process passes to the preload', () => {
    expect(windowKindFromArgv(['electron', '--milibot-window-kind=canvas'])).toBe('canvas')
    expect(windowKindFromArgv(['--milibot-window-kind=other'])).toBeNull()
    expect(windowKindFromArgv([])).toBeNull()
  })
})

describe('argument schemas', () => {
  it('checks frames coming over IPC', () => {
    expect(DesignExportFrame.parse({ name: 'A', html: '<p/>', width: 100, height: null })).toEqual({
      name: 'A',
      html: '<p/>',
      width: 100,
      height: null,
    })
    expect(() => DesignExportFrame.parse({ html: '<p/>', width: 0, height: 10 })).toThrow()
    expect(() => DesignExportFrame.parse({ html: 1, width: 10, height: 10 })).toThrow()
    expect(() => DesignExportFrame.parse(null)).toThrow()
  })

  it('accepts the CSS colors the renderer samples for the caption buttons', () => {
    expect(TitleBarColors.parse({ color: ' rgb(20, 22, 26)', symbolColor: '#e8e9ec' })).toEqual({
      color: 'rgb(20, 22, 26)',
      symbolColor: '#e8e9ec',
    })
    expect(TitleBarColors.safeParse({ color: 'rgba(0, 0, 0, 0.5)', symbolColor: 'white' }).success).toBe(true)
    for (const bad of [
      null,
      { color: 'red' },
      { color: 'url(x)', symbolColor: 'red' },
      { color: 'red;background:x', symbolColor: 'red' },
    ])
      expect(TitleBarColors.safeParse(bad).success).toBe(false)
  })
})
