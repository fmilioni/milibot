/** What an avatar is showing; each state plays its own micro-motion. */
export type AvatarState = 'idle' | 'thinking' | 'working' | 'talking' | 'paused' | 'effort'

export const AVATAR_STATES: readonly AvatarState[] = [
  'idle',
  'thinking',
  'working',
  'talking',
  'paused',
  'effort',
]

export function toAvatarState(status: string | null | undefined): AvatarState {
  return (AVATAR_STATES as readonly string[]).includes(status ?? '') ? (status as AvatarState) : 'idle'
}

export function resolveMotionPrefs(
  animateEyes: boolean,
  reduceMotion: boolean | null,
  systemReduce: boolean,
): { transitions: boolean; micro: boolean } {
  const enabled = animateEyes && !(reduceMotion ?? systemReduce)
  return { transitions: enabled, micro: enabled }
}

/** ~450 ms with a slight overshoot. */
export const POSE_SPRING = { type: 'spring', stiffness: 170, damping: 16, mass: 1 } as const
/** Shape radii must not overshoot below zero, so they settle without bounce. */
export const SHAPE_SPRING = { type: 'spring', stiffness: 190, damping: 24, mass: 1 } as const
export const MORPH_SPRING = { type: 'spring', stiffness: 210, damping: 26, mass: 1 } as const

export type MicroKind = 'blink-glance' | 'saccade' | 'drift' | 'shake' | 'bob' | 'none'

export const MICRO_BY_STATE: Record<AvatarState, MicroKind> = {
  idle: 'blink-glance',
  working: 'saccade',
  thinking: 'drift',
  effort: 'shake',
  talking: 'bob',
  paused: 'none',
}

export function between(min: number, max: number, random: () => number = Math.random): number {
  return min + (max - min) * random()
}

/** Delay until the next idle blink (3–6 s). */
export function nextBlinkMs(random?: () => number): number {
  return between(3000, 6000, random)
}

/** Small offsets in avatar units (viewBox 64). */
export function glanceOffset(random: () => number = Math.random): [number, number] {
  return [between(-3.5, 1.5, random), between(-1.5, 2, random)]
}

export function saccadeOffset(random: () => number = Math.random): [number, number] {
  return [between(-3, 3, random), between(-1.4, 1.4, random)]
}

export function driftOffset(random: () => number = Math.random): [number, number] {
  return [between(-2.5, 2.5, random), between(-1.6, 1.6, random)]
}

/** One CSS pixel expressed in viewBox units for an avatar rendered at `size` px. */
export function pixelInViewBox(size: number): number {
  return 64 / Math.max(size, 1)
}
