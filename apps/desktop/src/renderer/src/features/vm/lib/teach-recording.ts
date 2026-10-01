import type { RecordedStep } from '@milibot/shared'

import { SCREEN_H, SCREEN_W } from '@/lib/click-mark'

/** A press and release farther apart than this (native pixels) is a drag. */
const DRAG_THRESHOLD = 6
/** Two clicks at the same place within this are one double click. */
const DOUBLE_CLICK_MS = 400
/** Wheel events in the same direction within this are one scroll step. */
const SCROLL_MERGE_MS = 1200

/** User input captured from the noVNC canvas, already in native coordinates. */
export type TeachInput =
  | { type: 'mouse_down'; x: number; y: number; button: number; at: number }
  | { type: 'mouse_up'; x: number; y: number; button: number; at: number }
  | { type: 'wheel'; x: number; y: number; dx: number; dy: number; at: number }
  | {
      type: 'key'
      key: string
      ctrl: boolean
      alt: boolean
      shift: boolean
      meta: boolean
      at: number
    }

type TeachStepKind = RecordedStep['kind']

export interface TeachStep {
  id: number
  kind: TeachStepKind
  at: number
  x?: number
  y?: number
  toX?: number
  toY?: number
  text?: string
  keys?: string
  direction?: 'up' | 'down' | 'left' | 'right'
  amount?: number
  narration: string
  /** Clicks get a screenshot: `pending` until the daemon returns it, `null` when it failed. */
  screenshot?: { status: 'pending' } | { status: 'ready'; sha: string } | { status: 'failed' }
}

export interface TeachState {
  steps: TeachStep[]
  /** Button held down: the step it started (a click that may still become a drag). */
  pressed: { stepId: number; button: number } | null
  nextId: number
  paused: boolean
}

export type TeachAction =
  | TeachInput
  | { type: 'screenshot'; stepId: number; sha: string | null }
  | { type: 'undo' }
  | { type: 'narrate'; stepId: number; text: string }
  | { type: 'pause' }
  | { type: 'resume' }

export const INITIAL_TEACH_STATE: TeachState = { steps: [], pressed: null, nextId: 1, paused: false }

const MODIFIER_KEYS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'AltGraph', 'CapsLock', 'Fn', 'OS'])

/** DOM `KeyboardEvent.key` → xdotool key name. */
const KEY_NAMES: Record<string, string> = {
  Enter: 'Return',
  Backspace: 'BackSpace',
  Escape: 'Escape',
  Tab: 'Tab',
  Delete: 'Delete',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  Home: 'Home',
  End: 'End',
  PageUp: 'Page_Up',
  PageDown: 'Page_Down',
  Insert: 'Insert',
  ' ': 'space',
}

function keyName(key: string): string {
  if (KEY_NAMES[key]) return KEY_NAMES[key] as string
  if (key.length === 1) return key.toLowerCase()
  return key
}

/** `ctrl+shift+s` style combo of a key event (modifiers in a fixed order). */
export function keyCombo(input: Extract<TeachInput, { type: 'key' }>): string {
  const parts: string[] = []
  if (input.ctrl) parts.push('ctrl')
  if (input.alt) parts.push('alt')
  if (input.meta) parts.push('super')
  if (input.shift) parts.push('shift')
  parts.push(keyName(input.key))
  return parts.join('+')
}

function isTyping(input: Extract<TeachInput, { type: 'key' }>): boolean {
  return input.key.length === 1 && !input.ctrl && !input.alt && !input.meta
}

const CLICK_KINDS: Record<number, TeachStepKind> = { 0: 'click', 1: 'middle_click', 2: 'right_click' }

function replaceLast(steps: TeachStep[], step: TeachStep): TeachStep[] {
  return [...steps.slice(0, -1), step]
}

function onKey(state: TeachState, input: Extract<TeachInput, { type: 'key' }>): TeachState {
  if (MODIFIER_KEYS.has(input.key)) return state
  const last = state.steps.at(-1)
  if (isTyping(input)) {
    if (last?.kind === 'type')
      return {
        ...state,
        steps: replaceLast(state.steps, { ...last, text: `${last.text ?? ''}${input.key}` }),
      }
    return {
      ...state,
      steps: [
        ...state.steps,
        { id: state.nextId, kind: 'type', at: input.at, text: input.key, narration: '' },
      ],
      nextId: state.nextId + 1,
    }
  }
  const plain = !input.ctrl && !input.alt && !input.meta && !input.shift
  if (plain && input.key === 'Backspace' && last?.kind === 'type' && last.text) {
    const text = [...last.text].slice(0, -1).join('')
    return { ...state, steps: text ? replaceLast(state.steps, { ...last, text }) : state.steps.slice(0, -1) }
  }
  const keys = keyCombo(input)
  if (last?.kind === 'key' && last.keys === keys && input.at - last.at < 1500) {
    return {
      ...state,
      steps: replaceLast(state.steps, { ...last, at: input.at, amount: (last.amount ?? 1) + 1 }),
    }
  }
  return {
    ...state,
    steps: [...state.steps, { id: state.nextId, kind: 'key', at: input.at, keys, narration: '' }],
    nextId: state.nextId + 1,
  }
}

function onMouseDown(state: TeachState, input: Extract<TeachInput, { type: 'mouse_down' }>): TeachState {
  const kind = CLICK_KINDS[input.button]
  if (!kind) return state
  const last = state.steps.at(-1)
  if (
    kind === 'click' &&
    last?.kind === 'click' &&
    input.at - last.at <= DOUBLE_CLICK_MS &&
    Math.hypot((last.x ?? 0) - input.x, (last.y ?? 0) - input.y) <= DRAG_THRESHOLD
  ) {
    return {
      ...state,
      steps: replaceLast(state.steps, { ...last, kind: 'double_click' }),
      pressed: { stepId: last.id, button: input.button },
    }
  }
  const step: TeachStep = {
    id: state.nextId,
    kind,
    at: input.at,
    x: input.x,
    y: input.y,
    narration: '',
    screenshot: { status: 'pending' },
  }
  return {
    ...state,
    steps: [...state.steps, step],
    pressed: { stepId: step.id, button: input.button },
    nextId: state.nextId + 1,
  }
}

function onMouseUp(state: TeachState, input: Extract<TeachInput, { type: 'mouse_up' }>): TeachState {
  const pressed = state.pressed
  if (!pressed || pressed.button !== input.button) return { ...state, pressed: null }
  const steps = state.steps.map((step) => {
    if (step.id !== pressed.stepId || step.kind !== 'click') return step
    const moved = Math.hypot((step.x ?? 0) - input.x, (step.y ?? 0) - input.y) > DRAG_THRESHOLD
    return moved ? { ...step, kind: 'drag' as const, toX: input.x, toY: input.y } : step
  })
  return { ...state, steps, pressed: null }
}

function onWheel(state: TeachState, input: Extract<TeachInput, { type: 'wheel' }>): TeachState {
  const vertical = Math.abs(input.dy) >= Math.abs(input.dx)
  const delta = vertical ? input.dy : input.dx
  if (delta === 0) return state
  const direction = vertical ? (delta > 0 ? 'down' : 'up') : delta > 0 ? 'right' : 'left'
  const notches = Math.max(1, Math.round(Math.abs(delta) / 100))
  const last = state.steps.at(-1)
  if (last?.kind === 'scroll' && last.direction === direction && input.at - last.at <= SCROLL_MERGE_MS) {
    return {
      ...state,
      steps: replaceLast(state.steps, {
        ...last,
        at: input.at,
        amount: Math.min(1000, (last.amount ?? 0) + notches),
      }),
    }
  }
  return {
    ...state,
    steps: [
      ...state.steps,
      {
        id: state.nextId,
        kind: 'scroll',
        at: input.at,
        x: input.x,
        y: input.y,
        direction,
        amount: notches,
        narration: '',
      },
    ],
    nextId: state.nextId + 1,
  }
}

export function teachReducer(state: TeachState, action: TeachAction): TeachState {
  switch (action.type) {
    case 'pause':
      return { ...state, paused: true, pressed: null }
    case 'resume':
      return { ...state, paused: false }
    case 'undo':
      return { ...state, steps: state.steps.slice(0, -1), pressed: null }
    case 'narrate':
      return {
        ...state,
        steps: state.steps.map((s) => (s.id === action.stepId ? { ...s, narration: action.text } : s)),
      }
    case 'screenshot':
      return {
        ...state,
        steps: state.steps.map((s) =>
          s.id === action.stepId
            ? { ...s, screenshot: action.sha ? { status: 'ready', sha: action.sha } : { status: 'failed' } }
            : s,
        ),
      }
  }
  if (state.paused) return state
  switch (action.type) {
    case 'key':
      return onKey(state, action)
    case 'mouse_down':
      return onMouseDown(state, action)
    case 'mouse_up':
      return onMouseUp(state, action)
    case 'wheel':
      return onWheel(state, action)
  }
}

const KEY_LABELS: Record<string, string> = {
  ctrl: 'Ctrl',
  alt: 'Alt',
  super: 'Super',
  shift: 'Shift',
  Return: 'Enter',
  BackSpace: 'Backspace',
  Page_Up: 'Page Up',
  Page_Down: 'Page Down',
}

/** "ctrl+s" → "Ctrl+S", "Return" → "Enter" (display only; the recording keeps xdotool names). */
export function formatKeys(keys: string, spaceLabel = 'Space'): string {
  return keys
    .split('+')
    .map((part) =>
      part === 'space' ? spaceLabel : (KEY_LABELS[part] ?? (part.length === 1 ? part.toUpperCase() : part)),
    )
    .join('+')
}

/** Steps as sent to the daemon when the recording is finished. */
export function toRecordedSteps(steps: TeachStep[]): RecordedStep[] {
  return steps.map((step) => {
    const recorded: RecordedStep = { kind: step.kind, at: step.at }
    for (const key of ['x', 'y', 'toX', 'toY', 'text', 'keys', 'direction'] as const) {
      if (step[key] !== undefined) Object.assign(recorded, { [key]: step[key] })
    }
    if (step.kind === 'key' && (step.amount ?? 1) > 1) recorded.amount = step.amount
    if (step.kind === 'scroll') recorded.amount = step.amount ?? 1
    if (step.narration.trim()) recorded.narration = step.narration.trim()
    if (step.screenshot?.status === 'ready') recorded.screenshotSha = step.screenshot.sha
    return recorded
  })
}

/** Maps a pointer position over the scaled canvas to native desktop coordinates (clamped). */
export function toNative(
  clientX: number,
  clientY: number,
  rect: { left: number; top: number; width: number; height: number },
): { x: number; y: number } {
  const scaleX = rect.width > 0 ? SCREEN_W / rect.width : 1
  const scaleY = rect.height > 0 ? SCREEN_H / rect.height : 1
  const x = Math.round((clientX - rect.left) * scaleX)
  const y = Math.round((clientY - rect.top) * scaleY)
  return { x: Math.max(0, Math.min(SCREEN_W - 1, x)), y: Math.max(0, Math.min(SCREEN_H - 1, y)) }
}
