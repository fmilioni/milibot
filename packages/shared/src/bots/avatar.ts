import { z } from 'zod'

export const AVATAR_SHAPES = [
  'square',
  'triangle',
  'hexagon',
  'cloud',
  'drop',
  'ghost',
  'blob',
  'arch',
  'tv',
  'shield',
  'diamond',
] as const

export const AVATAR_COLORS = [
  'blue',
  'orange',
  'teal',
  'violet',
  'pink',
  'red',
  'green',
  'amber',
  'brown',
  'gray',
] as const

export const AVATAR_EYES = ['capsule', 'oval', 'slit'] as const

export const AvatarShape = z.enum(AVATAR_SHAPES)
export const AvatarColor = z.enum(AVATAR_COLORS)
export const AvatarEyes = z.enum(AVATAR_EYES)
export type AvatarShape = z.infer<typeof AvatarShape>
export type AvatarColor = z.infer<typeof AvatarColor>
export type AvatarEyes = z.infer<typeof AvatarEyes>

export const Avatar = z.object({
  shape: AvatarShape,
  color: AvatarColor,
  eyes: AvatarEyes,
})
export type Avatar = z.infer<typeof Avatar>

/** Identical in light and dark themes. */
export const AVATAR_COLOR_HEX: Record<AvatarColor, string> = {
  blue: '#3B82F6',
  orange: '#F97316',
  teal: '#14B8A6',
  violet: '#8B5CF6',
  pink: '#EC4899',
  red: '#EF4444',
  green: '#22C55E',
  amber: '#F5A524',
  brown: '#8B5E3C',
  gray: '#6B7280',
}

function pick<T>(items: readonly T[], random: () => number): T {
  return items[Math.floor(random() * items.length)] as T
}

export function randomAvatar(random: () => number = Math.random): Avatar {
  return {
    shape: pick(AVATAR_SHAPES, random),
    color: pick(AVATAR_COLORS, random),
    eyes: pick(AVATAR_EYES, random),
  }
}
