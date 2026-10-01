import { foldText } from '@milibot/shared'
import type { ReactNode } from 'react'

import type { Box, Size } from './tooltip'

export interface SelectOption<T extends string> {
  value: T
  label: string
  /** Secondary line under the label ("default · balance of cost and quality"). */
  description?: string | undefined
  /** Options with the same group are listed together under this header. */
  group?: string | undefined
  disabled?: boolean | undefined
  /** Rich lists (with `groups`): a badge after the label ("Recommended")… */
  badge?: string | undefined
  /** …and a right-aligned column ("~720 MB RAM" over "219 MB · 100% index"). */
  meta?: string | undefined
  metaDetail?: string | undefined
}

/** Header of a group in a rich list: title, vendor, a tag on the right and a description line. */
export interface SelectGroupInfo {
  title: string
  vendor?: string | undefined
  description?: string | undefined
  tag?: { label: string; icon?: ReactNode; tone?: 'success' | 'neutral' } | undefined
}

export interface DropdownPosition {
  placement: 'bottom' | 'top'
  left: number
  top: number
  /** Height the menu may take before it scrolls. */
  maxHeight: number
}

/**
 * Places a dropdown under its trigger, left-aligned, or above it when it does not fit below and
 * there is more room above. Clamped horizontally inside the viewport margins.
 */
export function computeDropdownPosition(
  anchor: Box,
  menu: Size,
  viewport: Size,
  gap = 4,
  margin = 8,
): DropdownPosition {
  const below = viewport.height - (anchor.top + anchor.height) - gap - margin
  const above = anchor.top - gap - margin
  const placement = menu.height <= below || below >= above ? 'bottom' : 'top'
  const room = Math.max(0, placement === 'bottom' ? below : above)
  const height = Math.min(menu.height, room)
  const top = placement === 'bottom' ? anchor.top + anchor.height + gap : anchor.top - gap - height
  const maxLeft = viewport.width - menu.width - margin
  const left = Math.max(margin, Math.min(anchor.left, maxLeft))
  return { placement, left: Math.round(left), top: Math.round(top), maxHeight: Math.floor(room) }
}

export interface NavOption {
  label: string
  disabled?: boolean | undefined
}

/** Next enabled index from `from` going `step` (±1), stopping at the ends (no active option: first/last). */
export function stepOption(options: NavOption[], from: number, step: 1 | -1): number {
  if (from < 0 || from >= options.length) return edgeOption(options, step === 1 ? 'first' : 'last')
  for (let i = from + step; i >= 0 && i < options.length; i += step) {
    if (!options[i]?.disabled) return i
  }
  return from
}

export function edgeOption(options: NavOption[], edge: 'first' | 'last'): number {
  const indexes = options.map((o, i) => (o.disabled ? -1 : i)).filter((i) => i >= 0)
  return (edge === 'first' ? indexes[0] : indexes.at(-1)) ?? -1
}

/**
 * Type-ahead: the first enabled option whose label starts with `query`, searching after `from`
 * (wrapping). Repeating one letter ("s", "ss") cycles through the options starting with it.
 */
export function typeaheadMatch(options: NavOption[], query: string, from: number): number {
  const q = foldText(query)
  if (!q) return -1
  const repeated = q.length > 1 && [...q].every((c) => c === q[0])
  const needle = repeated ? (q[0] as string) : q
  const start = repeated || q.length === 1 ? from + 1 : Math.max(from, 0)
  for (let k = 0; k < options.length; k++) {
    const i = (start + k + options.length) % options.length
    const option = options[i] as NavOption
    if (!option.disabled && foldText(option.label).startsWith(needle)) return i
  }
  return -1
}
