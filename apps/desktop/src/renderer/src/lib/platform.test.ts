import { describe, expect, it } from 'vitest'

import { hasModKey, isHostPaste, platformKind, shortcutLabel, shortPath } from './platform'

describe('platformKind', () => {
  it('maps process.platform, defaulting to macOS', () => {
    expect(platformKind('darwin')).toBe('mac')
    expect(platformKind('linux')).toBe('linux')
    expect(platformKind('win32')).toBe('windows')
    expect(platformKind('freebsd')).toBe('mac')
  })
})

describe('shortPath', () => {
  it('replaces the home folder with ~ on each platform', () => {
    expect(shortPath('/Users/ana/Library/Application Support/Milibot/workspaces/w1', 'mac')).toBe(
      '~/Library/Application Support/Milibot/workspaces/w1',
    )
    expect(shortPath('/home/ana/.local/share/milibot/workspaces/w1', 'linux')).toBe(
      '~/.local/share/milibot/workspaces/w1',
    )
    expect(shortPath('/root/.local/share/milibot', 'linux')).toBe('~/.local/share/milibot')
    expect(shortPath('/homeless/x', 'linux')).toBe('/homeless/x')
    expect(shortPath('C:\\Users\\ana\\AppData\\Local\\Milibot', 'windows')).toBe('~\\AppData\\Local\\Milibot')
    expect(shortPath('/srv/milibot', 'linux')).toBe('/srv/milibot')
  })
})

describe('isHostPaste', () => {
  const key = (k: Partial<KeyboardEvent>) => ({
    key: 'v',
    code: 'KeyV',
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    ...k,
  })
  it('is Cmd+V on the Mac, leaving Ctrl+V to the VM', () => {
    expect(isHostPaste(key({ metaKey: true }), 'mac')).toBe(true)
    expect(isHostPaste(key({ ctrlKey: true }), 'mac')).toBe(false)
  })
  it('is Ctrl+V (and Ctrl+Shift+V) on Linux and Windows', () => {
    expect(isHostPaste(key({ ctrlKey: true }), 'linux')).toBe(true)
    expect(isHostPaste(key({ ctrlKey: true, key: 'V' }), 'windows')).toBe(true)
    expect(isHostPaste(key({ ctrlKey: true, key: 'м' }), 'linux')).toBe(true)
    expect(isHostPaste(key({}), 'linux')).toBe(false)
    expect(isHostPaste(key({ ctrlKey: true, altKey: true }), 'windows')).toBe(false)
    expect(isHostPaste(key({ ctrlKey: true, key: 'c', code: 'KeyC' }), 'linux')).toBe(false)
  })
})

describe('shortcuts per platform', () => {
  const cmd = { metaKey: true, ctrlKey: false }
  const ctrl = { metaKey: false, ctrlKey: true }
  it('uses ⌘ on macOS and Ctrl elsewhere', () => {
    expect(hasModKey(cmd, 'mac')).toBe(true)
    expect(hasModKey(ctrl, 'mac')).toBe(false)
    expect(hasModKey(ctrl, 'linux')).toBe(true)
    expect(hasModKey(cmd, 'linux')).toBe(false)
    expect(hasModKey(ctrl, 'windows')).toBe(true)
  })
  it('labels the shortcut in the OS style', () => {
    expect(shortcutLabel('C', true, 'mac')).toBe('⇧⌘C')
    expect(shortcutLabel('C', true, 'linux')).toBe('Ctrl+Shift+C')
    expect(shortcutLabel('1', false, 'windows')).toBe('Ctrl+1')
  })
})
