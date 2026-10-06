import {
  type DesignFrame,
  type DesignRect,
  type DesignToken,
  isPagedSize,
  nearestFreeSpot,
  type PlacedFrame,
  rectsOverlap,
} from '@milibot/shared'

import { fitViewport, type Point, type Size, toScreen, toWorld, type Viewport } from '@/lib/viewport'

/** Height assumed for a frame that grows with its content and was never measured (as the daemon does). */
export const AUTO_HEIGHT_GUESS = 900
/** Gap the daemon keeps between a dropped frame and the ones around it. */
const DROP_GAP = 40
/** Screen distance under which a dragged frame snaps to another frame's edge. */
export const SNAP_PX = 6
/** Frames narrower than this on screen show a plain box instead of their page. */
export const MIN_RENDER_PX = 48
/** Screen space above a frame taken by its name label. */
export const FRAME_LABEL_HEIGHT = 20

export function rectToScreen(viewport: Viewport, rect: DesignRect): DesignRect {
  const origin = toScreen(viewport, rect)
  return { ...origin, width: rect.width * viewport.zoom, height: rect.height * viewport.zoom }
}

/** Height a frame takes on the canvas: its own, the one measured here, the daemon's or a guess. */
export function frameHeight(frame: DesignFrame, measured?: number): number {
  return frame.height ?? measured ?? frame.measuredHeight ?? AUTO_HEIGHT_GUESS
}

export function draftGrows(draft: { width: number; height: number | null }): boolean {
  return draft.height === null || !isPagedSize(draft.width, draft.height)
}

/** Never less than its height, the frame it replaces or a screen's proportions. */
export function draftHeight(
  draft: { width: number; height: number | null },
  measured: number | undefined,
  replaced: number | undefined,
): number {
  if (!draftGrows(draft)) return draft.height as number
  const floor = draft.height ?? replaced ?? Math.min(AUTO_HEIGHT_GUESS, Math.round(draft.width * 0.625))
  return Math.max(floor, measured ?? 0)
}

export function frameRects(
  frames: readonly DesignFrame[],
  measured: Readonly<Record<string, number>> = {},
): PlacedFrame[] {
  return frames.map((f) => ({
    id: f.id,
    x: f.x,
    y: f.y,
    width: f.width,
    height: frameHeight(f, measured[f.id]),
  }))
}

export function boundsOf(rects: readonly DesignRect[]): DesignRect | null {
  if (rects.length === 0) return null
  const left = Math.min(...rects.map((r) => r.x))
  const top = Math.min(...rects.map((r) => r.y))
  const right = Math.max(...rects.map((r) => r.x + r.width))
  const bottom = Math.max(...rects.map((r) => r.y + r.height))
  return { x: left, y: top, width: right - left, height: bottom - top }
}

/** `rect` grown upwards by the space of its name label. */
export function withLabel(rect: DesignRect): DesignRect {
  return { ...rect, y: rect.y - FRAME_LABEL_HEIGHT, height: rect.height + FRAME_LABEL_HEIGHT }
}

/** The viewport that shows every frame and its label (at most 100%). */
export function fitAll(
  frames: readonly DesignFrame[],
  measured: Readonly<Record<string, number>>,
  size: Size,
): Viewport {
  const bounds = boundsOf(frameRects(frames, measured))
  return fitViewport(bounds && withLabel(bounds), size, { padding: 64 })
}

/** A screen rect (with its label above it) entirely outside the stage. */
export function isOffscreen(screen: DesignRect, size: Size): boolean {
  return (
    screen.x > size.width ||
    screen.x + screen.width < 0 ||
    screen.y - FRAME_LABEL_HEIGHT > size.height ||
    screen.y + screen.height < 0
  )
}

/** Keeps the zoom and moves the view so `rect` is centered. */
export function centerOn(viewport: Viewport, rect: DesignRect, size: Size): Viewport {
  return {
    zoom: viewport.zoom,
    x: size.width / 2 - (rect.x + rect.width / 2) * viewport.zoom,
    y: size.height / 2 - (rect.y + rect.height / 2) * viewport.zoom,
  }
}

/** The frame under a world point; later frames are drawn on top. */
export function hitTest(rects: readonly PlacedFrame[], point: Point): string | null {
  for (let i = rects.length - 1; i >= 0; i--) {
    const r = rects[i] as PlacedFrame
    if (point.x >= r.x && point.x <= r.x + r.width && point.y >= r.y && point.y <= r.y + r.height) return r.id
  }
  return null
}

/** Frames that cross the screen (plus `margin` screen pixels around it). */
export function visibleFrameIds(
  rects: readonly PlacedFrame[],
  viewport: Viewport,
  size: Size,
  margin = 200,
): Set<string> {
  const view = {
    ...toWorld(viewport, { x: -margin, y: -margin }),
    width: (size.width + margin * 2) / viewport.zoom,
    height: (size.height + margin * 2) / viewport.zoom,
  }
  return new Set(rects.filter((r) => rectsOverlap(r, view)).map((r) => r.id))
}

export interface SnapResult {
  x: number
  y: number
  /** World x of the vertical guides and y of the horizontal ones the frame snapped to. */
  guides: { x: number[]; y: number[] }
}

/**
 * A dragged frame's position: its edges and center snap to the other frames' edges and centers closer
 * than `threshold` (world units).
 */
export function snapPosition(rect: DesignRect, others: readonly DesignRect[], threshold: number): SnapResult {
  const best = (mine: number[], theirs: number[]) => {
    let pick: { delta: number; line: number } | null = null
    for (const m of mine)
      for (const t of theirs) {
        const delta = t - m
        if (Math.abs(delta) <= threshold && (!pick || Math.abs(delta) < Math.abs(pick.delta)))
          pick = { delta, line: t }
      }
    return pick
  }
  const xs = others.flatMap((o) => [o.x, o.x + o.width / 2, o.x + o.width])
  const ys = others.flatMap((o) => [o.y, o.y + o.height / 2, o.y + o.height])
  const sx = best([rect.x, rect.x + rect.width / 2, rect.x + rect.width], xs)
  const sy = best([rect.y, rect.y + rect.height / 2, rect.y + rect.height], ys)
  return {
    x: Math.round(rect.x + (sx?.delta ?? 0)),
    y: Math.round(rect.y + (sy?.delta ?? 0)),
    guides: { x: sx ? [sx.line] : [], y: sy ? [sy.line] : [] },
  }
}

/**
 * Where a frame dropped at `rect` ends up: the daemon pushes it to the nearest free spot when it lands on
 * another frame (`pushed`), the same rule as here.
 */
export function dropSpot(
  rect: PlacedFrame,
  frames: readonly PlacedFrame[],
): { x: number; y: number; pushed: boolean } {
  const spot = nearestFreeSpot(rect, frames, rect.id, DROP_GAP)
  return { ...spot, pushed: spot.x !== rect.x || spot.y !== rect.y }
}

/**
 * Theme a frame shows: the one picked for that frame in the menu, else the one forced for the whole
 * canvas, else the frame's own (case-insensitive), else the design's first.
 */
export function resolveTheme(
  themes: readonly string[],
  frameTheme: string | null,
  forced: string | null = null,
  override: string | null = null,
): string {
  const find = (name: string | null) =>
    name ? (themes.find((t) => t.toLocaleLowerCase() === name.toLocaleLowerCase()) ?? null) : null
  return find(override) ?? find(forced) ?? find(frameTheme) ?? themes[0] ?? ''
}

/** Value of a token in a theme (per-theme value, else the shared one, else the first theme's). */
export function tokenValue(
  token: DesignToken,
  theme: string,
  themes: readonly string[],
): string | number | null {
  if (token.values[theme] !== undefined) return token.values[theme] as string | number
  if (token.value !== null) return token.value
  const first = themes[0]
  return first !== undefined && token.values[first] !== undefined
    ? (token.values[first] as string | number)
    : null
}

/**
 * Key of what a theme looks like (its token values and the fonts): a frame's page only changes with its
 * own content or this.
 */
export function themeKey(
  design: { tokens: readonly DesignToken[]; themes: readonly string[]; fonts: readonly string[] },
  theme: string,
): string {
  const parts = design.tokens.map((t) => `${t.name}=${String(tokenValue(t, theme, design.themes))}`)
  return hashString(`${theme}\n${design.fonts.join(',')}\n${parts.join('\n')}`)
}

/** Short FNV-1a hash (cache keys). */
export function hashString(value: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(36)
}

/** Background color of a theme (to paint a frame before its page loads), from the usual token names. */
export function themeBackground(
  design: { tokens: readonly DesignToken[]; themes: readonly string[] },
  theme: string,
): string | null {
  const names = ['color-background', 'color-bg', 'color-surface', 'color-base']
  for (const name of names) {
    const token = design.tokens.find((t) => t.name === name)
    const value = token ? tokenValue(token, theme, design.themes) : null
    if (typeof value === 'string') return value
  }
  return null
}

export type RevisionKind =
  | 'added'
  | 'rewritten'
  | 'edited'
  | 'moved'
  | 'resized'
  | 'renamed'
  | 'theme'
  | 'reordered'
  | 'deleted'
  | 'restored'
  | 'tokens'
  | 'undone'
  | 'changed'

/** What a revision did, from the daemon's English summary ("frame Home edited", "tokens: color-primary"). */
export function revisionKind(summary: string): RevisionKind {
  if (summary.startsWith('undid ')) return 'undone'
  if (summary.startsWith('tokens:') || /^(themes|fonts) /.test(summary)) return 'tokens'
  if (/ restored$|^restored /.test(summary)) return 'restored'
  if (/ added( \(copy of .*\))?$/.test(summary)) return 'added'
  if (/ renamed to /.test(summary)) return 'renamed'
  const last = /(rewritten|edited|moved|resized|reordered|deleted)$/.exec(summary)
  if (last) return last[1] as RevisionKind
  return / theme \S/.test(summary) ? 'theme' : 'changed'
}

/** The line the user's message starts with when it is about a frame ("Ask for a change"). */
export function frameContextPrefix(frame: string, design: string): string {
  return `[Frame "${frame}" of the design "${design}"]`
}

/** Splits a message written about a frame into the frame's name and the text. */
export function splitFrameContext(content: string): { frame: string | null; text: string } {
  const match = /^\[Frame "(.+)" of the design "(.+)"\]\n?/.exec(content)
  if (!match) return { frame: null, text: content }
  return { frame: match[1] as string, text: content.slice(match[0].length) }
}
