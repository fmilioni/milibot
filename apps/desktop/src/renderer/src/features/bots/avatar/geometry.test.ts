import type { AvatarShape } from '@milibot/shared'
import { AVATAR_EYES, AVATAR_SHAPES } from '@milibot/shared'
import { describe, expect, it } from 'vitest'

import {
  bodyGeometry,
  chevronPoints,
  clusterLayout,
  EYE_STYLES,
  eyePath,
  eyePoints,
  type EyePose,
  eyePose,
  highlightFrame,
  HIGHLIGHTS,
  highlightSide,
  type Point,
  signedArea,
} from './geometry'
import { AVATAR_STATES, type AvatarState, driftOffset, glanceOffset, saccadeOffset } from './motion-model'

const close = (a: number, b: number, eps = 0.35) => Math.abs(a - b) <= eps

describe('eyePose', () => {
  it('matches the design for the square (squircle) with capsule eyes', () => {
    // Centers measured in the avatar design (64px avatar, rotation pivots at the top-left).
    const idle = eyePose('square', 'capsule', 'idle')
    expect(close(idle.x - idle.spacing / 2, 38.76)).toBe(true)
    expect(close(idle.x + idle.spacing / 2, 50.92)).toBe(true)
    expect(close(idle.y, 21.37)).toBe(true)
    expect(idle.rotate).toBe(-14)
    expect(idle.h).toBeCloseTo(14.4)

    const thinking = eyePose('square', 'capsule', 'thinking')
    expect(close(thinking.x, 22.4)).toBe(true)
    expect(close(thinking.y, 20.8)).toBe(true)

    const working = eyePose('square', 'capsule', 'working')
    expect(close(working.x, 24.04)).toBe(true)
    expect(close(working.y, 38.97)).toBe(true)

    const effort = eyePose('square', 'capsule', 'effort')
    expect(effort.chevron).toBe(1)
    expect(close(effort.x, 32)).toBe(true)
    expect(close(effort.y, 30.4)).toBe(true)
  })

  it('places the drop eyes lower, following the design', () => {
    const idle = eyePose('drop', 'capsule', 'idle')
    expect(close(idle.y, 36.41, 0.6)).toBe(true)
    const thinking = eyePose('drop', 'capsule', 'thinking')
    expect(close(thinking.x, 24.32, 0.6)).toBe(true)
    expect(close(thinking.y, 36.48, 0.6)).toBe(true)
  })

  it('looks up-right when idle, up-left when thinking and down-left when working', () => {
    for (const shape of AVATAR_SHAPES) {
      for (const eyes of AVATAR_EYES) {
        const neutral = eyePose(shape, eyes, 'effort')
        const idle = eyePose(shape, eyes, 'idle')
        const thinking = eyePose(shape, eyes, 'thinking')
        const working = eyePose(shape, eyes, 'working')
        expect(idle.x).toBeGreaterThan(neutral.x)
        expect(idle.y).toBeLessThan(neutral.y)
        expect(thinking.x).toBeLessThan(neutral.x)
        expect(thinking.y).toBeLessThan(neutral.y)
        expect(working.x).toBeLessThan(neutral.x)
        expect(working.y).toBeGreaterThan(neutral.y)
      }
    }
  })

  it('keeps the configured eye (size and tilt) in every state but effort, which shows the chevrons', () => {
    for (const shape of AVATAR_SHAPES) {
      for (const eyes of AVATAR_EYES) {
        const idle = eyePose(shape, eyes, 'idle')
        const style = EYE_STYLES[eyes]
        expect(idle).toMatchObject({ w: style.w, rx: style.rx, rotate: style.tilt, chevron: 0 })
        for (const state of AVATAR_STATES) {
          const pose = eyePose(shape, eyes, state)
          if (state === 'effort') {
            expect(pose.chevron).toBe(1)
            expect(pose.rotate).toBe(0)
            continue
          }
          const { x: _x, y: _y, ...look } = pose
          const { x: _ix, y: _iy, ...idleLook } = idle
          expect(look, `${shape}/${eyes}/${state}`).toEqual(idleLook)
        }
      }
    }
  })

  it('keeps both eyes inside the 64 viewBox for every combination', () => {
    for (const shape of AVATAR_SHAPES) {
      for (const eyes of AVATAR_EYES) {
        for (const state of AVATAR_STATES) {
          const p = eyePose(shape, eyes, state)
          expect(p.x - p.spacing / 2 - p.w).toBeGreaterThan(0)
          expect(p.x + p.spacing / 2 + p.w).toBeLessThan(64)
          expect(p.y - p.h / 2).toBeGreaterThan(0)
          expect(p.y + p.h / 2).toBeLessThan(64)
          expect(p.ry).toBeLessThanOrEqual(p.h / 2 + 1e-9)
        }
      }
    }
  })

  it('keeps both eyes inside the body for every combination', () => {
    for (const shape of AVATAR_SHAPES) {
      const body = bodyOutline(shape)
      for (const eyes of AVATAR_EYES) {
        for (const state of AVATAR_STATES) {
          const p = eyePose(shape, eyes, state)
          const r = (p.rotate * Math.PI) / 180
          for (const side of [-1, 1]) {
            const outline = p.chevron
              ? chevronPoints(side < 0 ? 'right' : 'left')
              : eyePoints(p.w, p.h, p.rx, p.ry)
            const depth = Math.min(
              ...outline.map(([x, y]) =>
                depthInside(body, [
                  p.x + (side * p.spacing) / 2 + x * Math.cos(r) - y * Math.sin(r),
                  p.y + x * Math.sin(r) + y * Math.cos(r),
                ]),
              ),
            )
            expect(depth, `${shape}/${eyes}/${state}`).toBeGreaterThanOrEqual(0.5)
          }
        }
      }
    }
  })
})

describe('shapes', () => {
  it('defines a body for every shape', () => {
    for (const shape of AVATAR_SHAPES) expect(bodyGeometry(shape)).toBeTruthy()
  })

  it('draws a closed eye path that degrades to a slit without NaN', () => {
    expect(eyePath(6.72, 14.4, 3.36, 3.36)).toMatch(/^M.*Z$/)
    expect(eyePath(6.72, 0, 3.36, 3.36)).not.toContain('NaN')
  })

  it('samples eye and chevron outlines with the same winding so the morph never flips', () => {
    const eye = eyePoints(6.72, 14.4, 3.36, 3.36)
    expect(eye).toHaveLength(48)
    const eyeSign = Math.sign(signedArea(eye))
    expect(Math.sign(signedArea(chevronPoints('right')))).toBe(eyeSign)
    expect(Math.sign(signedArea(chevronPoints('left')))).toBe(eyeSign)
  })

  it('mirrors the chevrons (`> <`)', () => {
    const right = chevronPoints('right')
    const tip = Math.max(...right.map((p) => p[0]))
    const left = chevronPoints('left')
    expect(Math.min(...left.map((p) => p[0]))).toBeCloseTo(-tip)
  })
})

describe('clusterLayout', () => {
  it('shows every member for 2 to 4 and 3 + "+N" from 5 up', () => {
    expect(clusterLayout(2, 36).slots).toHaveLength(2)
    expect(clusterLayout(3, 36).slots).toHaveLength(3)
    const four = clusterLayout(4, 36)
    expect(four.slots).toHaveLength(4)
    expect(four.more).toBeNull()
    const seven = clusterLayout(7, 36)
    expect(seven.slots).toHaveLength(3)
    expect(seven.more?.count).toBe(4)
  })

  it('matches the design positions for three members at 36px', () => {
    const [a, b, c] = clusterLayout(3, 36).slots
    expect(a).toMatchObject({ x: 9, y: 0 })
    expect(Math.round(b?.y ?? 0)).toBe(17)
    expect(Math.round(c?.x ?? 0)).toBe(17)
    expect(Math.round(a?.size ?? 0)).toBe(19)
  })
})

describe('highlightFrame', () => {
  const h = HIGHLIGHTS.square
  it('rests at its own spot and at the mirrored spot', () => {
    expect(highlightFrame(h, 0)).toMatchObject({
      cx: h.cx,
      cy: h.cy,
      rotate: h.rotate,
      scaleX: 1,
      opacity: 1,
    })
    expect(highlightFrame(h, 1)).toMatchObject({
      cx: 64 - h.cx,
      cy: h.cy,
      rotate: -h.rotate,
      scaleX: 1,
      opacity: 1,
    })
    const cloud = HIGHLIGHTS.cloud
    expect(highlightFrame(cloud, 1)).toMatchObject({ cx: cloud.right?.cx, cy: cloud.right?.cy })
  })
  it('vanishes edge-on at the midpoint, exiting left and entering from the right', () => {
    expect(highlightFrame(h, 0.5).scaleX).toBeCloseTo(0)
    expect(highlightFrame(h, 0.4).cx).toBeLessThan(h.cx)
    expect(highlightFrame(h, 0.6).cx).toBeGreaterThan(64 - h.cx)
  })
  it('sits opposite the eyes: right whenever they look left', () => {
    expect(AVATAR_STATES.filter((s) => highlightSide(s) === 1)).toEqual(['thinking', 'working', 'talking'])
  })
})

/** Polygon of a body outline, flattening the curves of its SVG path (the commands the bodies use). */
function bodyOutline(shape: AvatarShape): Point[] {
  const body = bodyGeometry(shape)
  if (body.kind === 'ellipse') throw new Error('unsupported body')
  const d =
    body.kind === 'rect'
      ? `M${body.x + body.r} ${body.y}H${body.x + body.w - body.r}Q${body.x + body.w} ${body.y} ${body.x + body.w} ${body.y + body.r}` +
        `V${body.y + body.h - body.r}Q${body.x + body.w} ${body.y + body.h} ${body.x + body.w - body.r} ${body.y + body.h}` +
        `H${body.x + body.r}Q${body.x} ${body.y + body.h} ${body.x} ${body.y + body.h - body.r}` +
        `V${body.y + body.r}Q${body.x} ${body.y} ${body.x + body.r} ${body.y}Z`
      : body.d
  const tokens = d.match(/[a-zA-Z]|-?(?:\d+\.?\d*|\.\d+)/g) ?? []
  const points: Point[] = []
  let i = 0
  let cmd = ''
  let at: Point = [0, 0]
  let start: Point = [0, 0]
  let lastControl: Point | null = null
  const curve = (controls: Point[]) => {
    for (let s = 1; s <= 16; s++) {
      let layer = [at, ...controls]
      while (layer.length > 1)
        layer = layer.slice(1).map((p, k) => {
          const q = layer[k] as Point
          return [q[0] + ((p[0] - q[0]) * s) / 16, q[1] + ((p[1] - q[1]) * s) / 16] as Point
        })
      points.push(layer[0] as Point)
    }
    lastControl = controls.length === 3 ? (controls[1] as Point) : null
    at = controls[controls.length - 1] as Point
  }
  while (i < tokens.length) {
    if (/[a-zA-Z]/.test(tokens[i] as string)) cmd = tokens[i++] as string
    const rel = cmd === cmd.toLowerCase()
    const pt = (): Point => [(rel ? at[0] : 0) + Number(tokens[i++]), (rel ? at[1] : 0) + Number(tokens[i++])]
    switch (cmd.toUpperCase()) {
      case 'M':
        at = start = pt()
        points.push(at)
        cmd = rel ? 'l' : 'L'
        break
      case 'L':
        at = pt()
        points.push(at)
        break
      case 'H':
        at = [(rel ? at[0] : 0) + Number(tokens[i++]), at[1]]
        points.push(at)
        break
      case 'V':
        at = [at[0], (rel ? at[1] : 0) + Number(tokens[i++])]
        points.push(at)
        break
      case 'C':
        curve([pt(), pt(), pt()])
        break
      case 'S': {
        const c = lastControl as Point | null
        const reflected: Point = c ? [2 * at[0] - c[0], 2 * at[1] - c[1]] : at
        curve([reflected, pt(), pt()])
        break
      }
      case 'Q':
        curve([pt(), pt()])
        break
      case 'Z':
        at = start
        break
      default:
        throw new Error(`unsupported path command ${cmd}`)
    }
  }
  if (body.kind !== 'path' || !body.transform) return points
  const [tx, ty, kx, ky, ux, uy] = (body.transform.match(/-?\d+\.?\d*/g) ?? []).map(Number) as number[]
  return points.map(([x, y]) => [tx! + kx! * (x + ux!), ty! + ky! * (y + uy!)])
}

/** Distance from the polygon's contour: positive inside, negative outside. */
function depthInside(polygon: Point[], [px, py]: Point): number {
  let inside = false
  let nearest = Infinity
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [ax, ay] = polygon[i] as Point
    const [bx, by] = polygon[j] as Point
    if (ay > py !== by > py && px < ((bx - ax) * (py - ay)) / (by - ay) + ax) inside = !inside
    const dx = bx - ax
    const dy = by - ay
    const u = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy || 1)))
    nearest = Math.min(nearest, Math.hypot(px - ax - u * dx, py - ay - u * dy))
  }
  return inside ? nearest : -nearest
}

/** Outline of the highlight as BotAvatar draws it at wrap progress `t`. */
function highlightOutline(shape: AvatarShape, t: number): { points: Point[]; scaleX: number } {
  const f = highlightFrame(HIGHLIGHTS[shape], t)
  const r = (f.rotate * Math.PI) / 180
  const points = Array.from({ length: 48 }, (_, i): Point => {
    const a = (i / 48) * Math.PI * 2
    const x = f.rx * Math.cos(a)
    const y = f.ry * Math.sin(a)
    return [f.cx + (x * Math.cos(r) - y * Math.sin(r)) * f.scaleX, f.cy + x * Math.sin(r) + y * Math.cos(r)]
  })
  return { points, scaleX: f.scaleX }
}

/** Distance from a point to the nearer eye (rounded box), 0 or less when it is on an eye. */
function eyeGap(pose: EyePose, [px, py]: Point, [dx, dy]: Point = [0, 0]): number {
  let gap = Infinity
  for (const side of [-1, 1]) {
    const ox = px - (pose.x + (side * pose.spacing) / 2 + dx)
    const oy = py - (pose.y + dy)
    const r = (-pose.rotate * (1 - pose.chevron) * Math.PI) / 180
    const lx = Math.abs(ox * Math.cos(r) - oy * Math.sin(r))
    const ly = Math.abs(ox * Math.sin(r) + oy * Math.cos(r))
    const round = pose.chevron ? 0 : Math.min(pose.rx, pose.ry, pose.w / 2, pose.h / 2)
    const ex = Math.max(lx - pose.w / 2 + round, 0)
    const ey = Math.max(ly - pose.h / 2 + round, 0)
    gap = Math.min(gap, Math.hypot(ex, ey) - round)
  }
  return gap
}

/** Extremes of the micro animations' eye offsets per state. */
function microOffsets(state: AvatarState): Point[] {
  const range = { idle: glanceOffset, working: saccadeOffset, thinking: driftOffset }[state as string]
  if (range) {
    const [x0, y0] = range(() => 0)
    const [x1, y1] = range(() => 1)
    return [x0, x1].flatMap((x) => [y0, y1].map((y): Point => [x, y]))
  }
  return state === 'talking'
    ? [
        [0, 0],
        [0, -1.4],
      ]
    : [[0, 0]]
}

describe('highlight placement', () => {
  const MIN_EYE_GAP = 0.5
  // Narrower than this the highlight is an invisible sliver; the body clip hides it anyway.
  const VISIBLE_SCALE = 0.1

  it('rests well inside the body and flattens away before reaching the contour', () => {
    for (const shape of AVATAR_SHAPES) {
      const body = bodyOutline(shape)
      for (const t of [0, 1]) {
        const depth = Math.min(...highlightOutline(shape, t).points.map((p) => depthInside(body, p)))
        expect(depth, `${shape} at rest (t=${t})`).toBeGreaterThanOrEqual(1)
      }
      for (let i = 0; i <= 100; i++) {
        const { points, scaleX } = highlightOutline(shape, i / 100)
        if (scaleX < VISIBLE_SCALE) continue
        const depth = Math.min(...points.map((p) => depthInside(body, p)))
        expect(depth, `${shape} wrapping at t=${i / 100}`).toBeGreaterThanOrEqual(0)
      }
    }
  })

  it('never sits under the eyes at rest, glances and bobs included', () => {
    for (const shape of AVATAR_SHAPES)
      for (const eyes of AVATAR_EYES)
        for (const state of AVATAR_STATES) {
          const pose = eyePose(shape, eyes, state)
          const { points } = highlightOutline(shape, highlightSide(state))
          const gap = Math.min(...microOffsets(state).flatMap((o) => points.map((p) => eyeGap(pose, p, o))))
          expect(gap, `${shape}/${eyes}/${state}`).toBeGreaterThanOrEqual(MIN_EYE_GAP)
        }
  })

  it('never crosses the eyes while both move to another state', () => {
    // BotAvatar drives the wrap with the gaze's spring, so both share the same progress k (overshoot
    // included). Each eye is sized as the larger of both poses, so touching is already conservative.
    for (const shape of AVATAR_SHAPES)
      for (const eyes of AVATAR_EYES)
        for (const from of AVATAR_STATES)
          for (const to of AVATAR_STATES) {
            if (from === to) continue
            const a = eyePose(shape, eyes, from)
            const b = eyePose(shape, eyes, to)
            for (let i = 0; i <= 110; i += 2) {
              const k = i / 100
              const lerp = (p: number, q: number) => p + (q - p) * k
              const pose: EyePose = {
                x: lerp(a.x, b.x),
                y: lerp(a.y, b.y),
                rotate: lerp(a.rotate, b.rotate),
                spacing: Math.max(a.spacing, b.spacing),
                w: Math.max(a.w, b.w),
                h: Math.max(a.h, b.h),
                rx: Math.min(a.rx, b.rx),
                ry: Math.min(a.ry, b.ry),
                chevron: Math.max(a.chevron, b.chevron),
              }
              const { points, scaleX } = highlightOutline(shape, lerp(highlightSide(from), highlightSide(to)))
              if (scaleX < VISIBLE_SCALE) continue
              const gap = Math.min(...points.map((p) => eyeGap(pose, p)))
              expect(gap, `${shape}/${eyes} ${from}→${to} at k=${k}`).toBeGreaterThan(0)
            }
          }
  })
})
