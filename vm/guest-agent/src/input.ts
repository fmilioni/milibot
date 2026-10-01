import type { MouseButton } from '@milibot/shared/portable/guest-api'

import { badRequest } from './errors.ts'

const SCREEN_WIDTH = 1280
const SCREEN_HEIGHT = 800

/** Steps of one `InputAction` (guest-api.ts). A step is either an xdotool argv (without the binary, `stdin` fed to it) or a pure delay. */
export type InputStep = { xdotool: string[]; stdin?: string } | { sleepMs: number }

const BUTTONS: Record<MouseButton, string> = { left: '1', middle: '2', right: '3' }
const MAX_WAIT_MS = 30_000
const MAX_TEXT = 20_000
const MAX_SCROLL_CLICKS = 50

const KEY_ALIASES: Record<string, string> = {
  enter: 'Return',
  return: 'Return',
  esc: 'Escape',
  escape: 'Escape',
  tab: 'Tab',
  space: 'space',
  backspace: 'BackSpace',
  delete: 'Delete',
  del: 'Delete',
  insert: 'Insert',
  home: 'Home',
  end: 'End',
  pageup: 'Prior',
  pgup: 'Prior',
  pagedown: 'Next',
  pgdn: 'Next',
  up: 'Up',
  down: 'Down',
  left: 'Left',
  right: 'Right',
  arrowup: 'Up',
  arrowdown: 'Down',
  arrowleft: 'Left',
  arrowright: 'Right',
  ctrl: 'ctrl',
  control: 'ctrl',
  alt: 'alt',
  option: 'alt',
  shift: 'shift',
  super: 'super',
  meta: 'super',
  cmd: 'super',
  command: 'super',
  win: 'super',
  capslock: 'Caps_Lock',
  printscreen: 'Print',
  menu: 'Menu',
}

export function normalizeKeyCombo(combo: string): string {
  const trimmed = combo.trim()
  if (!trimmed) throw badRequest('empty key combo', 'invalid_key')
  if (!/^[A-Za-z0-9_+\-.,;:'"/\\[\]`=]+$/.test(trimmed) && trimmed !== '+') {
    throw badRequest(`invalid key combo: ${combo}`, 'invalid_key')
  }
  let parts: string[]
  if (trimmed === '+') parts = ['plus']
  else if (trimmed.endsWith('++')) parts = [...trimmed.slice(0, -2).split('+'), 'plus']
  else parts = trimmed.split('+')
  if (parts.some((p) => p === '')) throw badRequest(`invalid key combo: ${combo}`, 'invalid_key')
  return parts
    .map((part) => {
      const alias = KEY_ALIASES[part.toLowerCase()]
      if (alias) return alias
      if (/^f([1-9]|1[0-9]|2[0-4])$/i.test(part)) return part.toUpperCase()
      return part
    })
    .join('+')
}

function num(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value))
    throw badRequest(`${field} must be a number`, 'invalid_action')
  return value
}

function coord(value: unknown, field: 'x' | 'y'): string {
  const n = Math.round(num(value, field))
  const max = field === 'x' ? SCREEN_WIDTH - 1 : SCREEN_HEIGHT - 1
  if (n < 0 || n > max)
    throw badRequest(`${field}=${n} is outside the ${SCREEN_WIDTH}x${SCREEN_HEIGHT} screen`, 'out_of_bounds')
  return String(n)
}

function button(value: unknown, fallback: MouseButton = 'left'): string {
  if (value === undefined) return BUTTONS[fallback]
  if (typeof value !== 'string' || !(value in BUTTONS))
    throw badRequest(`invalid button: ${String(value)}`, 'invalid_action')
  return BUTTONS[value as MouseButton]
}

function moveArgs(x: unknown, y: unknown): string[] {
  return ['mousemove', coord(x, 'x'), coord(y, 'y')]
}

export function actionToSteps(raw: unknown): InputStep[] {
  if (!raw || typeof raw !== 'object') throw badRequest('action must be an object', 'invalid_action')
  const a = raw as Record<string, unknown>
  switch (a.type) {
    case 'click':
      return [{ xdotool: [...moveArgs(a.x, a.y), 'click', button(a.button)] }]
    case 'double_click':
      return [
        { xdotool: [...moveArgs(a.x, a.y), 'click', '--repeat', '2', '--delay', '80', button(a.button)] },
      ]
    case 'triple_click':
      return [
        { xdotool: [...moveArgs(a.x, a.y), 'click', '--repeat', '3', '--delay', '80', button(a.button)] },
      ]
    case 'right_click':
      return [{ xdotool: [...moveArgs(a.x, a.y), 'click', BUTTONS.right] }]
    case 'middle_click':
      return [{ xdotool: [...moveArgs(a.x, a.y), 'click', BUTTONS.middle] }]
    case 'move':
      return [{ xdotool: moveArgs(a.x, a.y) }]
    case 'mouse_down':
    case 'mouse_up': {
      const verb = a.type === 'mouse_down' ? 'mousedown' : 'mouseup'
      const prefix = a.x !== undefined || a.y !== undefined ? moveArgs(a.x, a.y) : []
      return [{ xdotool: [...prefix, verb, button(a.button)] }]
    }
    case 'drag': {
      const from = a.from as Record<string, unknown> | undefined
      const to = a.to as Record<string, unknown> | undefined
      if (!from || !to) throw badRequest('drag requires from and to', 'invalid_action')
      const b = button(a.button)
      return [
        { xdotool: [...moveArgs(from.x, from.y), 'mousedown', b] },
        { sleepMs: 100 },
        { xdotool: moveArgs(to.x, to.y) },
        { sleepMs: 100 },
        { xdotool: ['mouseup', b] },
      ]
    }
    case 'scroll': {
      const dx = Math.round(a.dx === undefined ? 0 : num(a.dx, 'dx'))
      const dy = Math.round(a.dy === undefined ? 0 : num(a.dy, 'dy'))
      if (dx === 0 && dy === 0) throw badRequest('scroll requires dx or dy', 'invalid_action')
      if (Math.abs(dx) > MAX_SCROLL_CLICKS || Math.abs(dy) > MAX_SCROLL_CLICKS) {
        throw badRequest(`scroll amount limited to ${MAX_SCROLL_CLICKS}`, 'invalid_action')
      }
      const args: string[] = a.x !== undefined || a.y !== undefined ? moveArgs(a.x, a.y) : []
      if (dy !== 0) args.push('click', '--repeat', String(Math.abs(dy)), '--delay', '30', dy > 0 ? '5' : '4')
      if (dx !== 0) args.push('click', '--repeat', String(Math.abs(dx)), '--delay', '30', dx > 0 ? '7' : '6')
      return [{ xdotool: args }]
    }
    case 'type': {
      if (typeof a.text !== 'string' || a.text.length === 0)
        throw badRequest('type requires text', 'invalid_action')
      if (a.text.length > MAX_TEXT) throw badRequest(`text limited to ${MAX_TEXT} chars`, 'invalid_action')
      const delay =
        a.delayMs === undefined ? 12 : Math.max(0, Math.min(200, Math.round(num(a.delayMs, 'delayMs'))))
      // The text goes through stdin: typed passwords never show up in the process list.
      return [{ xdotool: ['type', '--delay', String(delay), '--file', '-'], stdin: a.text }]
    }
    case 'key': {
      const list = Array.isArray(a.keys) ? a.keys : [a.keys]
      if (list.length === 0 || list.some((k) => typeof k !== 'string'))
        throw badRequest('key requires keys', 'invalid_action')
      return [
        {
          xdotool: [
            'key',
            '--clearmodifiers',
            '--delay',
            '40',
            '--',
            ...list.map((k) => normalizeKeyCombo(k as string)),
          ],
        },
      ]
    }
    case 'wait': {
      const ms = Math.round(num(a.ms, 'ms'))
      if (ms < 0 || ms > MAX_WAIT_MS) throw badRequest(`wait must be 0..${MAX_WAIT_MS}ms`, 'invalid_action')
      return [{ sleepMs: ms }]
    }
    default:
      throw badRequest(`unknown action type: ${String(a.type)}`, 'invalid_action')
  }
}
