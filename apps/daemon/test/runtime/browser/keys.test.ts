import { describe, expect, it } from 'vitest'

import { KeyComboError, keyComboEvents } from '../../../src/runtime/browser/keys'

describe('keyComboEvents', () => {
  it('types printable keys and presses named ones', () => {
    const enter = keyComboEvents('Enter')
    expect(enter.map((e) => e.type)).toEqual(['keyDown', 'keyUp'])
    expect(enter[0]).toMatchObject({ key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' })
    expect(keyComboEvents('e')[0]).toMatchObject({ key: 'e', code: 'KeyE', text: 'e', modifiers: 0 })
    expect(keyComboEvents('esc')[0]).toMatchObject({ key: 'Escape', type: 'rawKeyDown' })
  })

  it('holds modifiers around shortcuts without typing their character', () => {
    const events = keyComboEvents('ctrl+Shift+t')
    expect(events.map((e) => `${e.type}:${e.key}:${e.modifiers}`)).toEqual([
      'rawKeyDown:Control:2',
      'rawKeyDown:Shift:10',
      'rawKeyDown:T:10',
      'keyUp:T:10',
      'keyUp:Shift:2',
      'keyUp:Control:0',
    ])
    expect(events[2]?.text).toBeUndefined()
    expect(keyComboEvents('Shift+a')[1]).toMatchObject({ key: 'A', text: 'A' })
    expect(keyComboEvents('+')[0]).toMatchObject({ key: '+', text: '+' })
  })

  it('rejects unknown keys and modifiers', () => {
    expect(() => keyComboEvents('Hyper+a')).toThrow(KeyComboError)
    expect(() => keyComboEvents('Foo')).toThrow(KeyComboError)
    expect(() => keyComboEvents('')).toThrow(KeyComboError)
  })
})
