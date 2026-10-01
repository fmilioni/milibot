import { describe, expect, it } from 'vitest'

import {
  INITIAL_TEACH_STATE,
  keyCombo,
  type TeachAction,
  teachReducer,
  type TeachState,
  toNative,
  toRecordedSteps,
} from './teach-recording'

const key = (
  k: string,
  at: number,
  mods: Partial<Record<'ctrl' | 'alt' | 'shift' | 'meta', boolean>> = {},
): TeachAction => ({
  type: 'key',
  key: k,
  ctrl: false,
  alt: false,
  shift: false,
  meta: false,
  ...mods,
  at,
})

function run(actions: TeachAction[], state: TeachState = INITIAL_TEACH_STATE): TeachState {
  return actions.reduce(teachReducer, state)
}

describe('teach recording', () => {
  it('groups typed characters into one step and keeps shortcuts apart', () => {
    const state = run([
      ...'Café menu'.split('').map((c, i) => key(c, i)),
      key('Backspace', 20),
      key('s', 21, { ctrl: true }),
      key('R', 22, { shift: true }),
      key('e', 23),
    ])
    expect(state.steps.map((s) => [s.kind, s.text ?? s.keys])).toEqual([
      ['type', 'Café men'],
      ['key', 'ctrl+s'],
      ['type', 'Re'],
    ])
  })

  it('ignores modifier-only presses, names special keys and counts repeats', () => {
    const state = run([
      key('Shift', 1),
      key('Enter', 2),
      key('ArrowDown', 3),
      key('ArrowDown', 4),
      key('Tab', 5, { shift: true }),
    ])
    expect(state.steps.map((s) => [s.keys, s.amount])).toEqual([
      ['Return', undefined],
      ['Down', 2],
      ['shift+Tab', undefined],
    ])
    expect(keyCombo({ type: 'key', key: ' ', ctrl: true, alt: false, shift: false, meta: true, at: 0 })).toBe(
      'ctrl+super+space',
    )
  })

  it('backspace on an empty typed step removes it', () => {
    const state = run([key('a', 1), key('Backspace', 2)])
    expect(state.steps).toEqual([])
  })

  it('records clicks with a pending screenshot, double clicks, drags and right clicks', () => {
    const state = run([
      { type: 'mouse_down', x: 100, y: 100, button: 0, at: 0 },
      { type: 'mouse_up', x: 101, y: 100, button: 0, at: 50 },
      { type: 'mouse_down', x: 102, y: 101, button: 0, at: 200 },
      { type: 'mouse_up', x: 102, y: 101, button: 0, at: 250 },
      { type: 'mouse_down', x: 10, y: 10, button: 0, at: 1000 },
      { type: 'mouse_up', x: 300, y: 200, button: 0, at: 1400 },
      { type: 'mouse_down', x: 5, y: 5, button: 2, at: 2000 },
      { type: 'mouse_up', x: 5, y: 5, button: 2, at: 2050 },
    ])
    expect(state.steps.map((s) => [s.kind, s.x, s.y, s.toX, s.toY])).toEqual([
      ['double_click', 100, 100, undefined, undefined],
      ['drag', 10, 10, 300, 200],
      ['right_click', 5, 5, undefined, undefined],
    ])
    expect(state.steps.every((s) => s.screenshot?.status === 'pending')).toBe(true)
    expect(state.pressed).toBeNull()
  })

  it('a second click far away or late is its own step', () => {
    const state = run([
      { type: 'mouse_down', x: 100, y: 100, button: 0, at: 0 },
      { type: 'mouse_up', x: 100, y: 100, button: 0, at: 10 },
      { type: 'mouse_down', x: 100, y: 100, button: 0, at: 900 },
      { type: 'mouse_down', x: 400, y: 100, button: 0, at: 950 },
    ])
    expect(state.steps.map((s) => s.kind)).toEqual(['click', 'click', 'click'])
  })

  it('merges wheel events into one scroll step per direction', () => {
    const state = run([
      { type: 'wheel', x: 1, y: 1, dx: 0, dy: 100, at: 0 },
      { type: 'wheel', x: 1, y: 1, dx: 0, dy: 250, at: 100 },
      { type: 'wheel', x: 1, y: 1, dx: 0, dy: -100, at: 200 },
    ])
    expect(state.steps.map((s) => [s.direction, s.amount])).toEqual([
      ['down', 4],
      ['up', 1],
    ])
  })

  it('undo removes the last step; pause ignores input; narration and screenshots attach to steps', () => {
    let state = run([
      key('a', 1),
      { type: 'mouse_down', x: 1, y: 2, button: 0, at: 5 },
      { type: 'mouse_up', x: 1, y: 2, button: 0, at: 6 },
    ])
    const clickId = state.steps[1]?.id as number
    state = run(
      [
        { type: 'screenshot', stepId: clickId, sha: 'abc' },
        { type: 'narrate', stepId: clickId, text: ' File menu ' },
      ],
      state,
    )
    expect(toRecordedSteps(state.steps)).toEqual([
      { kind: 'type', at: 1, text: 'a' },
      { kind: 'click', at: 5, x: 1, y: 2, narration: 'File menu', screenshotSha: 'abc' },
    ])
    state = run([{ type: 'undo' }], state)
    expect(state.steps.map((s) => s.kind)).toEqual(['type'])
    state = run(
      [{ type: 'pause' }, key('b', 10), { type: 'mouse_down', x: 1, y: 1, button: 0, at: 11 }],
      state,
    )
    expect(state.steps).toHaveLength(1)
    state = run([{ type: 'resume' }, key('b', 12)], state)
    expect(state.steps[0]?.text).toBe('ab')
    state = run([{ type: 'screenshot', stepId: 999, sha: null }], state)
    expect(state.steps).toHaveLength(1)
  })

  it('formats key combos for people', async () => {
    const { formatKeys } = await import('./teach-recording')
    expect(formatKeys('ctrl+s')).toBe('Ctrl+S')
    expect(formatKeys('Return')).toBe('Enter')
    expect(formatKeys('ctrl+shift+Page_Up')).toBe('Ctrl+Shift+Page Up')
    expect(formatKeys('ctrl+space', 'Space bar')).toBe('Ctrl+Space bar')
  })

  it('maps pointer positions on the scaled canvas to native coordinates', () => {
    const rect = { left: 10, top: 20, width: 640, height: 400 }
    expect(toNative(10, 20, rect)).toEqual({ x: 0, y: 0 })
    expect(toNative(330, 220, rect)).toEqual({ x: 640, y: 400 })
    expect(toNative(9999, -5, rect)).toEqual({ x: 1279, y: 0 })
  })
})
