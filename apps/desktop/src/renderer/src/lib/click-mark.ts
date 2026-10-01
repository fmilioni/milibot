/** Native size of every bot desktop. */
export const SCREEN_W = 1280
export const SCREEN_H = 800

type ClickMarkKind = 'click' | 'double_click' | 'right_click' | 'middle_click' | 'drag' | 'move'

/** Where an action touched the screen, in native 1280x800 coordinates. */
export interface ClickMark {
  kind: ClickMarkKind
  x: number
  y: number
  toX?: number
  toY?: number
}

const POINT = /^\((\d+),\s*(\d+)\)$/
const DRAG = /^\((\d+),\s*(\d+)\)\s*→\s*\((\d+),\s*(\d+)\)$/
const POINT_KINDS = new Set<ClickMarkKind>(['click', 'double_click', 'right_click', 'middle_click', 'move'])

/** Click point of an activity step from its `kind` and `detail` ("(639, 771)", "(1, 2) → (3, 4)"). */
export function markFromActivity(kind: string, detail: string): ClickMark | null {
  const text = detail.trim()
  if (kind === 'drag') {
    const m = DRAG.exec(text)
    return m ? { kind: 'drag', x: Number(m[1]), y: Number(m[2]), toX: Number(m[3]), toY: Number(m[4]) } : null
  }
  if (!POINT_KINDS.has(kind as ClickMarkKind)) return null
  const m = POINT.exec(text)
  return m ? { kind: kind as ClickMarkKind, x: Number(m[1]), y: Number(m[2]) } : null
}

/** Position over an image of the whole screen, in percent (CSS `left`/`top`). */
export function markPercent(x: number, y: number): { left: number; top: number } {
  const clamp = (v: number) => Math.max(0, Math.min(100, v))
  return { left: clamp((x / SCREEN_W) * 100), top: clamp((y / SCREEN_H) * 100) }
}

/** Click point of a `computer` tool call (single action; batches have no single point). */
export function markFromToolArgs(toolName: string, args: unknown): ClickMark | null {
  if (toolName !== 'computer' && !toolName.endsWith('__computer')) return null
  if (!args || typeof args !== 'object') return null
  const a = args as Record<string, unknown>
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : null)
  const x = num(a.x)
  const y = num(a.y)
  if (x === null || y === null || typeof a.action !== 'string') return null
  if (a.action === 'drag') {
    const toX = num(a.to_x)
    const toY = num(a.to_y)
    return toX === null || toY === null ? null : { kind: 'drag', x, y, toX, toY }
  }
  return POINT_KINDS.has(a.action as ClickMarkKind) ? { kind: a.action as ClickMarkKind, x, y } : null
}

/** Arrow height for an image rendered `height` px tall: ~16% of it, between 12 and 32 px. */
export function markerSize(height: number): number {
  return Math.max(12, Math.min(32, Math.round(height * 0.16)))
}
