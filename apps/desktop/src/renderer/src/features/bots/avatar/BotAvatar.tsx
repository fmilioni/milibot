import { type Avatar, AVATAR_COLOR_HEX } from '@milibot/shared'
import { interpolate } from 'flubber'
import { animate, type AnimationPlaybackControls, type MotionValue, motionValue } from 'motion/react'
import { memo, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'

import {
  AVATAR_VIEWBOX,
  type BodyGeometry,
  bodyGeometry,
  chevronPoints,
  eyePath,
  eyePoints,
  type EyePose,
  eyePose,
  type Highlight,
  highlightFrame,
  HIGHLIGHTS,
  highlightSide,
  pointsToPath,
  TV_FEET,
  VOLUME_SHADOW_OFFSET,
} from './geometry'
import {
  between,
  driftOffset,
  glanceOffset,
  MICRO_BY_STATE,
  MORPH_SPRING,
  nextBlinkMs,
  pixelInViewBox,
  POSE_SPRING,
  saccadeOffset,
  SHAPE_SPRING,
  toAvatarState,
} from './motion-model'
import { useMotionPrefs } from './use-motion-prefs'

export interface BotAvatarProps {
  avatar: Avatar
  size?: number
  /** Bot status; unknown values fall back to idle. */
  state?: string | null
  /** Static avatars skip every animation (pickers, tiny inline chips). */
  animated?: boolean
  label?: string
  className?: string
}

function BodyShape({ body, ...paint }: { body: BodyGeometry; fill: string; fillOpacity?: number }) {
  if (body.kind === 'ellipse')
    return <ellipse cx={body.cx} cy={body.cy} rx={body.rx} ry={body.ry} {...paint} />
  if (body.kind === 'rect')
    return <rect x={body.x} y={body.y} width={body.w} height={body.h} rx={body.r} {...paint} />
  return <path d={body.d} transform={body.transform} {...paint} />
}

const POSE_KEYS = ['x', 'y', 'spacing', 'w', 'h', 'rx', 'ry', 'rotate', 'chevron'] as const
type PoseKey = (typeof POSE_KEYS)[number]
type ValueKey = PoseKey | 'lid' | 'mx' | 'my' | 'bob' | 'shake' | 'shine'
type Values = Record<ValueKey, MotionValue<number>>

const SHAPE_KEYS: ReadonlySet<PoseKey> = new Set(['w', 'h', 'rx', 'ry'])

interface Morph {
  left: (t: number) => string
  right: (t: number) => string
}

const CHEVRON_PATHS = {
  left: pointsToPath(chevronPoints('right')),
  right: pointsToPath(chevronPoints('left')),
}

const morphCache = new Map<string, Morph>()

function morphFor(pose: Pick<EyePose, 'w' | 'h' | 'rx' | 'ry'>): Morph {
  const key = [pose.w, pose.h, pose.rx, pose.ry].map((n) => n.toFixed(1)).join('|')
  let morph = morphCache.get(key)
  if (!morph) {
    const eye = eyePoints(pose.w, pose.h, pose.rx, pose.ry)
    const options = { maxSegmentLength: 1 }
    morph = {
      left: interpolate(eye, chevronPoints('right'), options),
      right: interpolate(eye, chevronPoints('left'), options),
    }
    if (morphCache.size > 64) morphCache.clear()
    morphCache.set(key, morph)
  }
  return morph
}

function createValues(pose: EyePose, shine: number): Values {
  return {
    ...(Object.fromEntries(POSE_KEYS.map((k) => [k, motionValue(pose[k])])) as Record<
      PoseKey,
      MotionValue<number>
    >),
    lid: motionValue(1),
    mx: motionValue(0),
    my: motionValue(0),
    bob: motionValue(0),
    shake: motionValue(0),
    shine: motionValue(shine),
  }
}

function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n
}

function shineAttributes(h: Highlight, t: number) {
  const f = highlightFrame(h, t)
  return {
    transform: `translate(${f.cx} ${f.cy}) scale(${f.scaleX} 1) rotate(${f.rotate})`,
    opacity: f.opacity,
  }
}

/**
 * Animated bot avatar. Eyes never teleport: every pose property is a spring-driven motion value,
 * and the switch to the `> <` effort chevrons morphs the outline with flubber while it moves.
 * Frames are written straight to the SVG attributes, so animating does not re-render React.
 */
export const BotAvatar = memo(function BotAvatar({
  avatar,
  size = 36,
  state,
  animated = true,
  label,
  className,
}: BotAvatarProps) {
  const baseId = useId()
  const clipId = `avatar-clip-${baseId}`
  const shadowId = `avatar-shadow-${baseId}`
  const prefs = useMotionPrefs()
  const transitions = animated && prefs.transitions
  const micro = animated && prefs.micro
  const avatarState = toAvatarState(state)
  const pose = eyePose(avatar.shape, avatar.eyes, avatarState)

  const shineTarget = highlightSide(avatarState)
  // Motion values live as long as the avatar; frames mutate them, never React state.
  const [values] = useState(() => createValues(pose, shineTarget))
  const morphRef = useRef<Morph | null>(null)
  const leftRef = useRef<SVGPathElement>(null)
  const rightRef = useRef<SVGPathElement>(null)
  const shakeRef = useRef<SVGGElement>(null)
  const shineRef = useRef<SVGEllipseElement>(null)
  const highlight = HIGHLIGHTS[avatar.shape]
  const highlightRef = useRef(highlight)
  useLayoutEffect(() => {
    highlightRef.current = highlight
  })
  const [initial] = useState(() => ({
    d: pose.chevron === 1 ? '' : eyePath(pose.w, pose.h, pose.rx, pose.ry),
    left: `translate(${pose.x - pose.spacing / 2} ${pose.y}) rotate(${pose.rotate})`,
    right: `translate(${pose.x + pose.spacing / 2} ${pose.y}) rotate(${pose.rotate})`,
  }))

  useLayoutEffect(() => {
    let scheduled = 0
    const draw = () => {
      scheduled = 0
      const v = (k: ValueKey) => values[k].get()
      const m = clamp01(v('chevron'))
      const h = Math.max(v('h') * v('lid'), 0.2)
      const cy = v('y') + v('my') + v('bob')
      const half = v('spacing') / 2
      const rotate = v('rotate') * (1 - m)
      const sides: [SVGPathElement | null, number, 'left' | 'right'][] = [
        [leftRef.current, -half, 'left'],
        [rightRef.current, half, 'right'],
      ]
      for (const [el, dx, side] of sides) {
        if (!el) continue
        let d: string
        if (m <= 0.001) d = eyePath(v('w'), h, v('rx'), Math.min(v('ry'), h / 2))
        else if (m >= 0.999 || !morphRef.current) d = CHEVRON_PATHS[side]
        else d = morphRef.current[side](m)
        el.setAttribute('d', d)
        el.setAttribute('transform', `translate(${v('x') + v('mx') + dx} ${cy}) rotate(${rotate})`)
      }
      shakeRef.current?.setAttribute('transform', `translate(${v('shake')} 0)`)
      if (shineRef.current) {
        const attrs = shineAttributes(highlightRef.current, v('shine'))
        shineRef.current.setAttribute('transform', attrs.transform)
        shineRef.current.setAttribute('fill-opacity', String(0.45 * attrs.opacity))
      }
    }
    const schedule = () => {
      scheduled ||= requestAnimationFrame(draw)
    }
    const unsubscribers = Object.values(values).map((mv) => mv.on('change', schedule))
    draw()
    return () => {
      cancelAnimationFrame(scheduled)
      for (const off of unsubscribers) off()
    }
  }, [values])

  useEffect(() => {
    if (!transitions) {
      values.shine.jump(shineTarget)
      return
    }
    // Same spring as the gaze: the highlight wraps in step with the eyes, so they never cross it.
    const controls = animate(values.shine, shineTarget, POSE_SPRING)
    return () => controls.stop()
  }, [shineTarget, transitions, values])

  const poseKey = POSE_KEYS.map((k) => pose[k].toFixed(2)).join(',')

  useEffect(() => {
    const target = pose
    const currentChevron = values.chevron.get()
    if (target.chevron !== currentChevron || (currentChevron > 0 && currentChevron < 1)) {
      // Entering the chevron morphs from the eye as it is now; leaving it morphs into the target eye.
      const from =
        target.chevron === 1
          ? { w: values.w.get(), h: values.h.get(), rx: values.rx.get(), ry: values.ry.get() }
          : target
      morphRef.current = morphFor(from)
    }
    if (!transitions) {
      for (const key of POSE_KEYS) values[key].jump(target[key])
      return
    }
    const controls: AnimationPlaybackControls[] = POSE_KEYS.map((key) =>
      animate(
        values[key],
        target[key],
        key === 'chevron' ? MORPH_SPRING : SHAPE_KEYS.has(key) ? SHAPE_SPRING : POSE_SPRING,
      ),
    )
    return () => {
      for (const c of controls) c.stop()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `poseKey` captures every field of `pose`
  }, [poseKey, transitions, values])

  useEffect(() => {
    const reset = () => {
      values.lid.jump(1)
      values.shake.jump(0)
      if (transitions) {
        animate(values.mx, 0, POSE_SPRING)
        animate(values.my, 0, POSE_SPRING)
        animate(values.bob, 0, POSE_SPRING)
      } else {
        values.mx.jump(0)
        values.my.jump(0)
        values.bob.jump(0)
      }
    }
    reset()
    if (!micro) return

    const timers = new Set<ReturnType<typeof setTimeout>>()
    const running = new Set<AnimationPlaybackControls>()
    let stopped = false
    const later = (ms: number, fn: () => void) => {
      const id = setTimeout(() => {
        timers.delete(id)
        if (!stopped) fn()
      }, ms)
      timers.add(id)
    }
    const run = (controls: AnimationPlaybackControls) => {
      running.add(controls)
      void controls.finished.then(() => running.delete(controls))
    }
    const moveTo = ([x, y]: [number, number], spring: object) => {
      run(animate(values.mx, x, spring))
      run(animate(values.my, y, spring))
    }

    switch (MICRO_BY_STATE[avatarState]) {
      case 'blink-glance': {
        const blink = () => {
          run(animate(values.lid, [1, 0.1, 1], { duration: 0.18, times: [0, 0.4, 1], ease: 'easeInOut' }))
          later(nextBlinkMs(), blink)
        }
        const glance = () => {
          if (Math.random() < 0.55) {
            moveTo(glanceOffset(), { type: 'spring', stiffness: 260, damping: 22 })
            later(between(700, 1400), () => moveTo([0, 0], { type: 'spring', stiffness: 200, damping: 22 }))
          }
          later(between(4000, 8000), glance)
        }
        later(nextBlinkMs(), blink)
        later(between(2500, 5000), glance)
        break
      }
      case 'saccade': {
        const saccade = () => {
          moveTo(saccadeOffset(), { type: 'spring', stiffness: 900, damping: 38 })
          later(between(250, 800), saccade)
        }
        later(300, saccade)
        break
      }
      case 'drift': {
        const drift = () => {
          moveTo(driftOffset(), { type: 'spring', stiffness: 30, damping: 12 })
          later(between(1400, 2400), drift)
        }
        later(200, drift)
        break
      }
      case 'shake': {
        const px = pixelInViewBox(size)
        const id = setInterval(() => values.shake.set(values.shake.get() > 0 ? -px : px), 55)
        return () => {
          stopped = true
          clearInterval(id)
          values.shake.jump(0)
        }
      }
      case 'bob': {
        let up = false
        const bob = () => {
          up = !up
          run(animate(values.bob, up ? -1.4 : 0, { type: 'spring', stiffness: 500, damping: 20 }))
          later(between(160, 260), bob)
        }
        later(100, bob)
        break
      }
      case 'none':
        break
    }
    return () => {
      stopped = true
      for (const id of timers) clearTimeout(id)
      for (const c of running) c.stop()
    }
  }, [avatarState, micro, transitions, size, values])

  const body = bodyGeometry(avatar.shape)
  const fill = AVATAR_COLOR_HEX[avatar.color]
  const shine = shineAttributes(highlight, values.shine.get())
  // Below ~20px the shadow/highlight read as noise more than volume, so they fade out.
  const glossOpacity = clamp01((size - 14) / 8)
  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${AVATAR_VIEWBOX} ${AVATAR_VIEWBOX}`}
      className={className}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      data-avatar-state={avatarState}
      overflow="visible"
    >
      <defs>
        <clipPath id={clipId}>
          <BodyShape body={body} fill="#000" />
        </clipPath>
        <mask id={shadowId} maskUnits="userSpaceOnUse">
          <BodyShape body={body} fill="#FFF" />
          <g transform={`translate(0 ${-VOLUME_SHADOW_OFFSET})`}>
            <BodyShape body={body} fill="#000" />
          </g>
        </mask>
      </defs>
      <g ref={shakeRef}>
        {avatar.shape === 'tv' &&
          TV_FEET.map((foot, i) => (
            <rect
              key={i}
              x={foot.x}
              y={foot.y}
              width={foot.w}
              height={foot.h}
              rx={foot.r}
              fill={`color-mix(in srgb, ${fill} 65%, #000)`}
            />
          ))}
        <BodyShape body={body} fill={fill} />
        {glossOpacity > 0 && (
          <g clipPath={`url(#${clipId})`} opacity={glossOpacity}>
            <g mask={`url(#${shadowId})`}>
              <BodyShape body={body} fill="#000" fillOpacity={0.18} />
            </g>
            <ellipse
              ref={shineRef}
              rx={highlight.rx}
              ry={highlight.ry}
              transform={shine.transform}
              fill="#FFFFFF"
              fillOpacity={0.45 * shine.opacity}
            />
          </g>
        )}
        <path ref={leftRef} d={initial.d || CHEVRON_PATHS.left} transform={initial.left} fill="#FFFFFF" />
        <path ref={rightRef} d={initial.d || CHEVRON_PATHS.right} transform={initial.right} fill="#FFFFFF" />
      </g>
    </svg>
  )
})
