import { type DesignProblem, slugify } from '@milibot/shared'

import { artInfo, type FrameRow } from './store'

/** File name part of an export (pinned: bots and users find their files by it). */
export function fileSlug(value: string): string {
  return slugify(value).slice(0, 60) || 'frame'
}

export function frameSize(row: FrameRow): string {
  return `${row.width}×${row.height ?? `auto${row.measured_height ? ` (${row.measured_height})` : ''}`}`
}

export function problemLines(problems: readonly DesignProblem[]): string {
  return problems.length
    ? `Problems (${problems.length}):\n${problems.map((p) => `- ${p.message}`).join('\n')}`
    : 'No layout problems found.'
}

export function artState(frame: FrameRow, now: number): string {
  const info = artInfo(frame)
  if (frame.art_status === 'drawing')
    return `art · drawing (${Math.max(1, Math.round((now - (info?.startedAt ?? now)) / 60_000))} min)`
  if (frame.art_status === 'failed') return `art · failed: ${info?.error ?? 'unknown reason'}`
  return 'art · ready'
}

export function artOnly(frame: FrameRow): string {
  return (
    `"${frame.name}" is an art frame: redraw it with design_draw (same name) and place it in frames with ` +
    `<img data-art="${frame.name}">`
  )
}
