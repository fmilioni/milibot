import { ToolInputError } from '@milibot/agent/tools'

/** Key names and combos ("Enter", "Control+a", "shift+Tab") → CDP `Input.dispatchKeyEvent` params. */

interface KeyDef {
  key: string
  code: string
  keyCode: number
  text?: string
}

const MODIFIERS: Record<string, { def: KeyDef; bit: number }> = {
  alt: { def: { key: 'Alt', code: 'AltLeft', keyCode: 18 }, bit: 1 },
  control: { def: { key: 'Control', code: 'ControlLeft', keyCode: 17 }, bit: 2 },
  meta: { def: { key: 'Meta', code: 'MetaLeft', keyCode: 91 }, bit: 4 },
  shift: { def: { key: 'Shift', code: 'ShiftLeft', keyCode: 16 }, bit: 8 },
}

const MODIFIER_ALIASES: Record<string, string> = {
  alt: 'alt',
  option: 'alt',
  ctrl: 'control',
  control: 'control',
  meta: 'meta',
  cmd: 'meta',
  command: 'meta',
  super: 'meta',
  win: 'meta',
  shift: 'shift',
}

const NAMED: Record<string, KeyDef> = {
  enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
  backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
  insert: { key: 'Insert', code: 'Insert', keyCode: 45 },
  space: { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
  arrowleft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  arrowup: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  arrowright: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  arrowdown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  pageup: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
  pagedown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
  home: { key: 'Home', code: 'Home', keyCode: 36 },
  end: { key: 'End', code: 'End', keyCode: 35 },
}

const ALIASES: Record<string, string> = {
  return: 'enter',
  esc: 'escape',
  del: 'delete',
  up: 'arrowup',
  down: 'arrowdown',
  left: 'arrowleft',
  right: 'arrowright',
  pgup: 'pageup',
  pgdn: 'pagedown',
  pagedn: 'pagedown',
  spacebar: 'space',
}

const PUNCTUATION: Record<string, [string, number]> = {
  ';': ['Semicolon', 186],
  '=': ['Equal', 187],
  ',': ['Comma', 188],
  '-': ['Minus', 189],
  '.': ['Period', 190],
  '/': ['Slash', 191],
  '`': ['Backquote', 192],
  '[': ['BracketLeft', 219],
  '\\': ['Backslash', 220],
  ']': ['BracketRight', 221],
  "'": ['Quote', 222],
}

export interface CdpKeyEvent {
  type: 'keyDown' | 'rawKeyDown' | 'keyUp'
  key: string
  code: string
  windowsVirtualKeyCode: number
  nativeVirtualKeyCode: number
  modifiers: number
  text?: string
  unmodifiedText?: string
}

export class KeyComboError extends ToolInputError {}

function keyDef(name: string, shift: boolean): KeyDef {
  const lower = name.toLowerCase()
  const named = NAMED[ALIASES[lower] ?? lower]
  if (named) return named
  if (/^f([1-9]|1[0-2])$/i.test(name)) {
    const n = Number(name.slice(1))
    return { key: `F${n}`, code: `F${n}`, keyCode: 111 + n }
  }
  if ([...name].length !== 1) throw new KeyComboError(`unknown key "${name}"`)
  if (/^[a-z]$/i.test(name)) {
    const key = shift ? name.toUpperCase() : name.toLowerCase()
    return { key, code: `Key${name.toUpperCase()}`, keyCode: name.toUpperCase().charCodeAt(0), text: key }
  }
  if (/^[0-9]$/.test(name))
    return { key: name, code: `Digit${name}`, keyCode: name.charCodeAt(0), text: name }
  const punct = PUNCTUATION[name]
  return { key: name, code: punct?.[0] ?? '', keyCode: punct?.[1] ?? 0, text: name }
}

/** "Control+Shift+t" → modifier downs, the key down/up, modifier ups. */
export function keyComboEvents(combo: string): CdpKeyEvent[] {
  const trimmed = combo.trim()
  if (!trimmed) throw new KeyComboError('empty key')
  const parts = trimmed === '+' ? ['+'] : trimmed.split(/\+(?!$)/).map((p) => p.trim())
  const keyName = parts.pop() as string
  const mods = parts.map((p) => {
    const mod = MODIFIER_ALIASES[p.toLowerCase()]
    if (!mod) throw new KeyComboError(`unknown modifier "${p}" (use Control, Alt, Shift or Meta)`)
    return MODIFIERS[mod] as { def: KeyDef; bit: number }
  })
  let modifiers = 0
  const events: CdpKeyEvent[] = []
  const base = (def: KeyDef) => ({
    key: def.key,
    code: def.code,
    windowsVirtualKeyCode: def.keyCode,
    nativeVirtualKeyCode: def.keyCode,
  })
  for (const mod of mods) {
    modifiers |= mod.bit
    events.push({ type: 'rawKeyDown', ...base(mod.def), modifiers })
  }
  const def = keyDef(keyName, (modifiers & 8) !== 0)
  // Shortcuts (Control/Alt/Meta held) must not type their character.
  const text = def.text !== undefined && (modifiers & 7) === 0 ? def.text : undefined
  events.push({
    type: text !== undefined ? 'keyDown' : 'rawKeyDown',
    ...base(def),
    modifiers,
    ...(text !== undefined ? { text, unmodifiedText: text } : {}),
  })
  events.push({ type: 'keyUp', ...base(def), modifiers })
  for (const mod of [...mods].reverse()) {
    modifiers &= ~mod.bit
    events.push({ type: 'keyUp', ...base(mod.def), modifiers })
  }
  return events
}
