import type { AvatarEyes, AvatarShape } from '@milibot/shared'

import type { AvatarState } from './motion-model'

/**
 * Avatar geometry in a 64×64 viewBox, measured from the avatar design.
 * Everything here is pure so it can be unit tested and shared by the animated and static renderers.
 */
export const AVATAR_VIEWBOX = 64

interface BodyPath {
  kind: 'path'
  d: string
  /** Design viewBox of the path, mapped onto `box` (x, y, w, h) in avatar space. */
  viewBox: [number, number, number, number]
  box: [number, number, number, number]
}

function mapPath(body: BodyPath): string {
  const [vx, vy, vw, vh] = body.viewBox
  const [bx, by, bw, bh] = body.box
  return `translate(${bx} ${by}) scale(${bw / vw} ${bh / vh}) translate(${-vx} ${-vy})`
}

function roundedPolygon(points: [number, number][], radius: number): string {
  const n = points.length
  let d = ''
  for (let i = 0; i < n; i++) {
    const prev = points[(i - 1 + n) % n] as [number, number]
    const curr = points[i] as [number, number]
    const next = points[(i + 1) % n] as [number, number]
    const toPrev = [prev[0] - curr[0], prev[1] - curr[1]]
    const toNext = [next[0] - curr[0], next[1] - curr[1]]
    const lenPrev = Math.hypot(toPrev[0] as number, toPrev[1] as number)
    const lenNext = Math.hypot(toNext[0] as number, toNext[1] as number)
    const r = Math.min(radius, lenPrev / 2, lenNext / 2)
    const a = [
      curr[0] + ((toPrev[0] as number) / lenPrev) * r,
      curr[1] + ((toPrev[1] as number) / lenPrev) * r,
    ]
    const b = [
      curr[0] + ((toNext[0] as number) / lenNext) * r,
      curr[1] + ((toNext[1] as number) / lenNext) * r,
    ]
    d += `${i === 0 ? 'M' : 'L'}${fmt(a[0] as number)} ${fmt(a[1] as number)}Q${fmt(curr[0])} ${fmt(curr[1])} ${fmt(b[0] as number)} ${fmt(b[1] as number)}`
  }
  return `${d}Z`
}

function hexagonPath(): string {
  const cx = 32
  const cy = 32
  const r = 30.4
  const points: [number, number][] = [-90, -30, 30, 90, 150, 210].map((deg) => {
    const rad = (deg * Math.PI) / 180
    return [cx + r * Math.cos(rad), cy + r * Math.sin(rad)]
  })
  return roundedPolygon(points, 8)
}

export type BodyGeometry =
  | { kind: 'ellipse'; cx: number; cy: number; rx: number; ry: number }
  | { kind: 'rect'; x: number; y: number; w: number; h: number; r: number }
  | { kind: 'path'; d: string; transform?: string }

const PATHS: Record<'triangle' | 'cloud' | 'drop' | 'ghost' | 'blob', BodyPath> = {
  triangle: {
    kind: 'path',
    d: 'M17.4 2.6c1.2-2.1 4-2.1 5.2 0l16.8 29.8c1.2 2.1-0.3 4.6-2.7 4.6l-33.4 0c-2.4 0-3.9-2.5-2.7-4.6z',
    viewBox: [-0.4, 0.5, 40.8, 36.5],
    box: [0, 3.2, 64, 59.2],
  },
  cloud: {
    kind: 'path',
    d: 'M10 32c-6 0-10-4-10-9 0-5 4-8.5 8.5-8.5 0.5-7.5 6.5-13 13.5-13 6 0 10.5 4 11.5 9.5 4 1.5 6.5 5.5 6.5 10 0 6-4.5 11-10.5 11z',
    viewBox: [0, 0, 40, 32],
    box: [0, 4.8, 64, 51.2],
  },
  drop: {
    kind: 'path',
    d: 'M17 0c5 8 17 16 17 25 0 9-7.5 15-17 15-9.5 0-17-6-17-15 0-9 12-17 17-25z',
    viewBox: [0, 0, 34, 40],
    box: [4.8, 0, 54.4, 64],
  },
  ghost: {
    kind: 'path',
    d: 'M4 18c0-10 7-17 16-17 9 0 16 7 16 17l0 18c0 2.5-2.5 3.5-4.5 2l-3.5-2.5-4 3c-2 1.5-6 1.5-8 0l-4-3-3.5 2.5c-2 1.5-4.5 0.5-4.5-2z',
    viewBox: [0, 0, 40, 40],
    box: [0, 0, 64, 64],
  },
  blob: {
    kind: 'path',
    d: 'M22 2c9 0 17 6 16 15-0.5 5-4 7-3 12 1 6-5 10-13 9.5-9-0.5-18-3.5-19.5-12.5-1.5-9 3.5-14 7.5-19 3-3.5 7-5 12-5z',
    viewBox: [0, 0, 40, 40],
    box: [0, 0, 64, 64],
  },
}

const HEXAGON = hexagonPath()

/** Squircle: the "square" id, redrawn with rounder super-elliptical corners. */
const SQUIRCLE = 'M32 4C52 4 60 12 60 32S52 60 32 60 4 52 4 32 12 4 32 4Z'

const ARCH = 'M6 30C6 12 17 4 32 4S58 12 58 30V52Q58 60 50 60H14Q6 60 6 52Z'

/** Body only; the two feet are drawn separately in BotAvatar (outside the clip, darkened). */
const TV = { x: 2, y: 8, w: 60, h: 46, r: 14 }
export const TV_FEET = [
  { x: 15, y: 50, w: 7, h: 10, r: 3 },
  { x: 42, y: 50, w: 7, h: 10, r: 3 },
] as const

const SHIELD =
  'M5 16Q5 6 15 6L49 6Q59 6 59 16L59 24Q59 34 52.06 41.2L38.94 54.8Q32 62 25.06 54.8L11.94 41.2Q5 34 5 24Z'

const DIAMOND =
  'M23.51 9.49Q32 1 40.49 9.49L54.51 23.51Q63 32 54.51 40.49L40.49 54.51Q32 63 23.51 54.51L9.49 40.49Q1 32 9.49 23.51Z'

export function bodyGeometry(shape: AvatarShape): BodyGeometry {
  switch (shape) {
    case 'square':
      return { kind: 'path', d: SQUIRCLE }
    case 'hexagon':
      return { kind: 'path', d: HEXAGON }
    case 'arch':
      return { kind: 'path', d: ARCH }
    case 'tv':
      return { kind: 'rect', x: TV.x, y: TV.y, w: TV.w, h: TV.h, r: TV.r }
    case 'shield':
      return { kind: 'path', d: SHIELD }
    case 'diamond':
      return { kind: 'path', d: DIAMOND }
    default: {
      const body = PATHS[shape]
      return { kind: 'path', d: body.d, transform: mapPath(body) }
    }
  }
}

/**
 * "Volume" style overlays (`BotAvatar`): a translucent shadow along the bottom and a glossy highlight
 * ellipse near the top-left. The shadow is the body minus the body shifted up by this many units, so
 * its lower edge is the body's own contour for every shape (flat bottoms get a band, round ones a
 * crescent, points a chevron) and it fades to nothing where the sides are vertical.
 */
export const VOLUME_SHADOW_OFFSET = 8

export interface Highlight {
  cx: number
  cy: number
  rx: number
  ry: number
  rotate: number
  /** How far (viewBox units) it slides towards the edge while it flattens away; default 8. */
  travel?: number
  /** Resting center on the right side, for bodies that are not symmetric; default the mirrored spot. */
  right?: { cx: number; cy: number }
}

const DEFAULT_HIGHLIGHT: Highlight = { cx: 19, cy: 14, rx: 7, ry: 4, rotate: -30 }

/**
 * Per-shape highlight spot. Each one sits inside the body on both sides and clear of every eye pose,
 * and `travel` is short enough that it flattens to nothing before reaching the contour (see the tests).
 */
export const HIGHLIGHTS: Record<AvatarShape, Highlight> = {
  square: DEFAULT_HIGHLIGHT,
  hexagon: { ...DEFAULT_HIGHLIGHT, cy: 16, travel: 3.5 },
  ghost: { ...DEFAULT_HIGHLIGHT, travel: 5.5 },
  // The blob is lopsided: its right spot sits a bit higher and further out, clear of the eyes
  // looking up-left.
  blob: { ...DEFAULT_HIGHLIGHT, cy: 17, travel: 4, right: { cx: 46, cy: 16 } },
  // The cloud's big bump is off-center, so each side gets its own spot under it.
  cloud: { ...DEFAULT_HIGHLIGHT, cx: 24, cy: 18, travel: 3.5, right: { cx: 43, cy: 16 } },
  arch: { cx: 19, cy: 18, rx: 7, ry: 4, rotate: -30 },
  tv: { cx: 17, cy: 19, rx: 8, ry: 4.5, rotate: -18 },
  shield: { cx: 18, cy: 16, rx: 6.5, ry: 3.4, rotate: -35 },
  // Triangle, drop and diamond have their point (not a flat corner) up top: the highlight moves
  // down into the widest, lit-from-above part of the body instead, above the eyes' paths.
  triangle: { cx: 23, cy: 26, rx: 6, ry: 3.6, rotate: -50, travel: 3 },
  drop: { cx: 16, cy: 31, rx: 6.5, ry: 3.6, rotate: -35, travel: 5 },
  diamond: { cx: 16, cy: 25, rx: 6, ry: 3.2, rotate: -45, travel: 3 },
}

/**
 * Highlight side per state: always opposite the eyes' horizontal gaze, so they never sit on it. When
 * the eyes swing left the body reads as turning left: the highlight slides left, flattens against the
 * edge as if going around a curved surface and comes back from the right edge (and the mirror of that
 * when they swing right). A centered gaze keeps the default top-left spot.
 */
export function highlightSide(state: AvatarState): 0 | 1 {
  return GAZE[state][0] < 0 ? 1 : 0
}

export interface HighlightFrame {
  cx: number
  cy: number
  rx: number
  ry: number
  rotate: number
  /** Horizontal squash (1 = full width, 0 = gone edge-on). */
  scaleX: number
  opacity: number
}

/**
 * Highlight at wrap progress `t`: 0 = its own spot (top-left), 1 = the mirrored spot (top-right).
 * The first half exits through the left edge, the second half enters from the right edge; it never
 * leaves the body because it shrinks to zero width before reaching the contour.
 */
export function highlightFrame(h: Highlight, t: number): HighlightFrame {
  const k = t < 0 ? 0 : t > 1 ? 1 : t
  const right = k > 0.5
  // 0 at a resting spot, 1 at the edge where the highlight vanishes.
  const p = right ? (1 - k) * 2 : k * 2
  const ease = p * p
  const scaleX = 1 - ease
  const slide = (h.travel ?? 8) * ease
  const rest = right ? (h.right ?? { cx: AVATAR_VIEWBOX - h.cx, cy: h.cy }) : h
  return {
    cx: right ? rest.cx + slide : rest.cx - slide,
    cy: rest.cy,
    rx: h.rx,
    ry: h.ry,
    rotate: right ? -h.rotate : h.rotate,
    scaleX,
    opacity: 1 - p * p * p,
  }
}

/** Where the eyes sit on each body and how far the gaze can travel (relative to the circle). */
interface Face {
  cx: number
  cy: number
  gazeX: number
  gazeY: number
  eyeHeight: number
}

const FACES: Record<AvatarShape, Face> = {
  square: { cx: 32, cy: 30.4, gazeX: 1, gazeY: 1, eyeHeight: 1 },
  triangle: { cx: 32, cy: 44, gazeX: 0.5, gazeY: 0.73, eyeHeight: 1 },
  hexagon: { cx: 32, cy: 30.4, gazeX: 0.925, gazeY: 0.9, eyeHeight: 1 },
  cloud: { cx: 33.5, cy: 35, gazeX: 0.825, gazeY: 0.73, eyeHeight: 1 },
  drop: { cx: 32, cy: 42.24, gazeX: 0.82, gazeY: 0.62, eyeHeight: 1 },
  ghost: { cx: 32, cy: 30, gazeX: 0.66, gazeY: 0.75, eyeHeight: 1 },
  blob: { cx: 32, cy: 30.4, gazeX: 0.83, gazeY: 1, eyeHeight: 1 },
  arch: { cx: 32, cy: 32, gazeX: 1, gazeY: 0.85, eyeHeight: 1 },
  tv: { cx: 32, cy: 31, gazeX: 1.05, gazeY: 0.72, eyeHeight: 1 },
  shield: { cx: 32, cy: 26, gazeX: 0.9, gazeY: 0.5, eyeHeight: 1 },
  diamond: { cx: 32, cy: 32, gazeX: 0.7, gazeY: 0.7, eyeHeight: 1 },
}

/** Gaze offset of the eye pair from the face center, per state (circle, capsule eyes). */
const GAZE: Record<AvatarState, [number, number]> = {
  idle: [12.84, -9.03],
  thinking: [-9.6, -9.6],
  working: [-7.96, 8.57],
  talking: [-9.6, -9.6],
  paused: [0, 0],
  effort: [0, 0],
}

interface EyeStyleSpec {
  w: number
  h: number
  rx: number
  ry: number
  spacing: number
  /** Tilt in degrees (negative = counter-clockwise, a "\\" lean). */
  tilt: number
  /** Scales the gaze travel so smaller eyes land where the design puts them. */
  gazeX: number
  gazeY: number
}

export const EYE_STYLES: Record<AvatarEyes, EyeStyleSpec> = {
  capsule: {
    w: 6.72,
    h: 14.4,
    rx: 3.36,
    ry: 3.36,
    spacing: 12.16,
    tilt: -14,
    gazeX: 1,
    gazeY: 1,
  },
  oval: {
    w: 8.8,
    h: 12,
    rx: 4.4,
    ry: 6,
    spacing: 13.44,
    tilt: 0,
    gazeX: 0.75,
    gazeY: 0.89,
  },
  slit: {
    w: 10.4,
    h: 4.16,
    rx: 2.08,
    ry: 2.08,
    spacing: 12.16,
    tilt: 0,
    gazeX: 0.75,
    gazeY: 0.71,
  },
}

/** Chevron box (`> <`), stroke drawn as a filled outline so it can morph. */
const CHEVRON = { w: 7.36, h: 12.16, stroke: 3.2, spacing: 12.16 }

/** Full, animatable description of the eye pair; each eye is centered at (x ± spacing/2, y). */
export interface EyePose {
  x: number
  y: number
  spacing: number
  w: number
  h: number
  rx: number
  ry: number
  rotate: number
  /** 0 = eye shape, 1 = chevron. */
  chevron: number
}

export function eyePose(shape: AvatarShape, eyes: AvatarEyes, state: AvatarState): EyePose {
  const face = FACES[shape]
  const style = EYE_STYLES[eyes]
  const [gx, gy] = GAZE[state]
  const x = face.cx + gx * face.gazeX * style.gazeX
  const y = face.cy + gy * face.gazeY * style.gazeY
  if (state === 'effort') {
    const h = CHEVRON.h * face.eyeHeight
    return {
      x,
      y,
      spacing: CHEVRON.spacing,
      w: CHEVRON.w,
      h,
      rx: style.rx,
      ry: Math.min(style.ry, h / 2),
      rotate: 0,
      chevron: 1,
    }
  }
  // Every other state keeps the configured eye; only the gaze moves.
  const h = style.h * face.eyeHeight
  return {
    x,
    y,
    spacing: style.spacing,
    w: style.w,
    h,
    rx: style.rx,
    ry: Math.min(style.ry, h / 2),
    rotate: style.tilt,
    chevron: 0,
  }
}

function fmt(n: number): string {
  return String(Math.round(n * 100) / 100)
}

/** Rounded rectangle with elliptical corners, centered at the origin (covers capsule, dot, oval and slit). */
export function eyePath(w: number, h: number, rx: number, ry: number): string {
  const hw = w / 2
  const hh = Math.max(h, 0.01) / 2
  const cx = Math.min(Math.max(rx, 0), hw)
  const cy = Math.min(Math.max(ry, 0), hh)
  return (
    `M${fmt(-hw + cx)} ${fmt(-hh)}H${fmt(hw - cx)}A${fmt(cx)} ${fmt(cy)} 0 0 1 ${fmt(hw)} ${fmt(-hh + cy)}` +
    `V${fmt(hh - cy)}A${fmt(cx)} ${fmt(cy)} 0 0 1 ${fmt(hw - cx)} ${fmt(hh)}H${fmt(-hw + cx)}` +
    `A${fmt(cx)} ${fmt(cy)} 0 0 1 ${fmt(-hw)} ${fmt(hh - cy)}V${fmt(-hh + cy)}` +
    `A${fmt(cx)} ${fmt(cy)} 0 0 1 ${fmt(-hw + cx)} ${fmt(-hh)}Z`
  )
}

export type Point = [number, number]

/** Samples the eye outline clockwise from the top center, for path morphing. */
export function eyePoints(w: number, h: number, rx: number, ry: number, count = 48): Point[] {
  const hw = w / 2
  const hh = Math.max(h, 0.01) / 2
  const cx = Math.min(rx, hw)
  const cy = Math.min(ry, hh)
  // Superellipse-free parametrization: walk the angle and clamp to the rounded rect.
  const points: Point[] = []
  for (let i = 0; i < count; i++) {
    const t = -Math.PI / 2 + (i / count) * Math.PI * 2
    const dx = Math.cos(t)
    const dy = Math.sin(t)
    const sx = Math.sign(dx) || 1
    const sy = Math.sign(dy) || 1
    // Intersect the ray with the straight edges first.
    const tx = Math.abs(dx) > 1e-9 ? hw / Math.abs(dx) : Infinity
    const ty = Math.abs(dy) > 1e-9 ? hh / Math.abs(dy) : Infinity
    let px = dx * Math.min(tx, ty)
    let py = dy * Math.min(tx, ty)
    const inCornerX = Math.abs(px) > hw - cx
    const inCornerY = Math.abs(py) > hh - cy
    if (inCornerX && inCornerY && cx > 0 && cy > 0) {
      // Project onto the corner ellipse centered at (±(hw-cx), ±(hh-cy)).
      const ox = sx * (hw - cx)
      const oy = sy * (hh - cy)
      const angle = Math.atan2((py - oy) / cy, (px - ox) / cx)
      px = ox + cx * Math.cos(angle)
      py = oy + cy * Math.sin(angle)
    }
    points.push([px, py])
  }
  return points
}

/** Filled outline of a chevron stroke centered at the origin; `>` points right, `<` points left. */
export function chevronPoints(
  direction: 'right' | 'left',
  w = CHEVRON.w,
  h = CHEVRON.h,
  stroke = CHEVRON.stroke,
): Point[] {
  const sx = w / 5
  const sy = h / 8
  const flip = direction === 'right' ? 1 : -1
  const line: Point[] = [
    [flip * (0.5 * sx - w / 2), 0.5 * sy - h / 2],
    [flip * (4.5 * sx - w / 2), 4 * sy - h / 2],
    [flip * (0.5 * sx - w / 2), 7.5 * sy - h / 2],
  ]
  const [p0, p1, p2] = line as [Point, Point, Point]
  const half = stroke / 2
  const normal = (a: Point, b: Point): Point => {
    const dx = b[0] - a[0]
    const dy = b[1] - a[1]
    const len = Math.hypot(dx, dy)
    return [-dy / len, dx / len]
  }
  const n1 = normal(p0, p1)
  const n2 = normal(p1, p2)
  const miter = (sign: number): Point => {
    const mx = n1[0] + n2[0]
    const my = n1[1] + n2[1]
    const len = Math.hypot(mx, my)
    const cos = (mx / len) * n1[0] + (my / len) * n1[1]
    const scale = (half / cos) * sign
    return [p1[0] + (mx / len) * scale, p1[1] + (my / len) * scale]
  }
  const cap = (center: Point, from: Point, steps = 4): Point[] => {
    const start = Math.atan2(from[1], from[0])
    return Array.from({ length: steps - 1 }, (_, i) => {
      const a = start - (Math.PI * (i + 1)) / steps
      return [center[0] + half * Math.cos(a), center[1] + half * Math.sin(a)] as Point
    })
  }
  const outline: Point[] = [
    [p0[0] + n1[0] * half, p0[1] + n1[1] * half],
    miter(1),
    [p2[0] + n2[0] * half, p2[1] + n2[1] * half],
    ...cap(p2, n2),
    [p2[0] - n2[0] * half, p2[1] - n2[1] * half],
    miter(-1),
    [p0[0] - n1[0] * half, p0[1] - n1[1] * half],
    ...cap(p0, [-n1[0], -n1[1]]),
  ]
  // Keep a clockwise winding (in y-down space) like `eyePoints` so the morph does not flip inside out.
  return signedArea(outline) < 0 ? outline.reverse() : outline
}

export function signedArea(points: Point[]): number {
  let sum = 0
  for (let i = 0; i < points.length; i++) {
    const a = points[i] as Point
    const b = points[(i + 1) % points.length] as Point
    sum += a[0] * b[1] - b[0] * a[1]
  }
  return sum / 2
}

export function pointsToPath(points: Point[]): string {
  return `${points.map((p, i) => `${i === 0 ? 'M' : 'L'}${fmt(p[0])} ${fmt(p[1])}`).join('')}Z`
}

interface ClusterSlot {
  x: number
  y: number
  size: number
}

export interface ClusterLayout {
  slots: ClusterSlot[]
  /** Slot for the "+N" chip when more members exist than fit. */
  more: (ClusterSlot & { count: number }) | null
}

/** Group avatar cluster (fractions of the container size). */
export function clusterLayout(memberCount: number, size: number): ClusterLayout {
  const s = (v: number) => v * size
  if (memberCount <= 1) return { slots: memberCount === 1 ? [{ x: 0, y: 0, size }] : [], more: null }
  if (memberCount === 2) {
    return {
      slots: [
        { x: 0, y: 0, size: s(0.61) },
        { x: s(0.39), y: s(0.39), size: s(0.61) },
      ],
      more: null,
    }
  }
  if (memberCount === 3) {
    return {
      slots: [
        { x: s(0.25), y: 0, size: s(0.528) },
        { x: 0, y: s(0.472), size: s(0.528) },
        { x: s(0.472), y: s(0.472), size: s(0.528) },
      ],
      more: null,
    }
  }
  const quad: ClusterSlot[] = [
    { x: 0, y: 0, size: s(0.472) },
    { x: s(0.528), y: 0, size: s(0.472) },
    { x: 0, y: s(0.528), size: s(0.472) },
    { x: s(0.528), y: s(0.528), size: s(0.472) },
  ]
  if (memberCount === 4) return { slots: quad, more: null }
  return { slots: quad.slice(0, 3), more: { ...(quad[3] as ClusterSlot), count: memberCount - 3 } }
}
