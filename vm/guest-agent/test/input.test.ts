import { describe, expect, it } from 'vitest'

import { actionToSteps, normalizeKeyCombo } from '../src/input.ts'

describe('actionToSteps', () => {
  it('maps clicks', () => {
    expect(actionToSteps({ type: 'click', x: 10, y: 20 })).toEqual([
      { xdotool: ['mousemove', '10', '20', 'click', '1'] },
    ])
    expect(actionToSteps({ type: 'right_click', x: 1, y: 2 })).toEqual([
      { xdotool: ['mousemove', '1', '2', 'click', '3'] },
    ])
    expect(actionToSteps({ type: 'double_click', x: 5.4, y: 6.6 })).toEqual([
      { xdotool: ['mousemove', '5', '7', 'click', '--repeat', '2', '--delay', '80', '1'] },
    ])
    expect(actionToSteps({ type: 'click', x: 0, y: 0, button: 'middle' })[0]).toEqual({
      xdotool: ['mousemove', '0', '0', 'click', '2'],
    })
  })

  it('enforces screen bounds', () => {
    expect(() => actionToSteps({ type: 'click', x: 1280, y: 0 })).toThrow(/outside/)
    expect(() => actionToSteps({ type: 'move', x: 0, y: -1 })).toThrow(/outside/)
    expect(() => actionToSteps({ type: 'move', x: 'a', y: 1 })).toThrow(/number/)
  })

  it('maps drag into down/move/up with pauses', () => {
    expect(actionToSteps({ type: 'drag', from: { x: 1, y: 2 }, to: { x: 3, y: 4 } })).toEqual([
      { xdotool: ['mousemove', '1', '2', 'mousedown', '1'] },
      { sleepMs: 100 },
      { xdotool: ['mousemove', '3', '4'] },
      { sleepMs: 100 },
      { xdotool: ['mouseup', '1'] },
    ])
  })

  it('maps scroll directions to wheel buttons', () => {
    expect(actionToSteps({ type: 'scroll', dy: 3 })).toEqual([
      { xdotool: ['click', '--repeat', '3', '--delay', '30', '5'] },
    ])
    expect(actionToSteps({ type: 'scroll', x: 100, y: 100, dy: -2, dx: 1 })).toEqual([
      {
        xdotool: [
          'mousemove',
          '100',
          '100',
          'click',
          '--repeat',
          '2',
          '--delay',
          '30',
          '4',
          'click',
          '--repeat',
          '1',
          '--delay',
          '30',
          '7',
        ],
      },
    ])
    expect(() => actionToSteps({ type: 'scroll' })).toThrow()
  })

  it('types the text from stdin, never as an argument', () => {
    expect(actionToSteps({ type: 'type', text: '--help' })).toEqual([
      { xdotool: ['type', '--delay', '12', '--file', '-'], stdin: '--help' },
    ])
    expect(() => actionToSteps({ type: 'type', text: '' })).toThrow()
  })

  it('maps keys with aliases', () => {
    expect(actionToSteps({ type: 'key', keys: 'ctrl+c' })).toEqual([
      { xdotool: ['key', '--clearmodifiers', '--delay', '40', '--', 'ctrl+c'] },
    ])
    expect(actionToSteps({ type: 'key', keys: ['Enter', 'cmd+shift+t'] })[0]).toEqual({
      xdotool: ['key', '--clearmodifiers', '--delay', '40', '--', 'Return', 'super+shift+t'],
    })
  })

  it('validates waits and unknown types', () => {
    expect(actionToSteps({ type: 'wait', ms: 250 })).toEqual([{ sleepMs: 250 }])
    expect(() => actionToSteps({ type: 'wait', ms: 999_999 })).toThrow()
    expect(() => actionToSteps({ type: 'explode' })).toThrow(/unknown/)
    expect(() => actionToSteps(null)).toThrow()
  })
})

describe('normalizeKeyCombo', () => {
  it('normalizes aliases and function keys', () => {
    expect(normalizeKeyCombo('Esc')).toBe('Escape')
    expect(normalizeKeyCombo('ctrl+PageDown')).toBe('ctrl+Next')
    expect(normalizeKeyCombo('f5')).toBe('F5')
    expect(normalizeKeyCombo('ctrl++')).toBe('ctrl+plus')
    expect(normalizeKeyCombo('a')).toBe('a')
  })

  it('rejects shell-ish or empty input', () => {
    expect(() => normalizeKeyCombo('')).toThrow()
    expect(() => normalizeKeyCombo('a b')).toThrow()
    expect(() => normalizeKeyCombo('$(rm)')).toThrow()
  })
})
