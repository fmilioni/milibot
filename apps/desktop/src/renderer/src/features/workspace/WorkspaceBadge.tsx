import { AVATAR_COLOR_HEX, type AvatarColor } from '@milibot/shared'

export function WorkspaceBadge({
  name,
  color,
  icon,
  size = 24,
}: {
  name: string
  color: AvatarColor
  /** Letter(s) or emoji chosen in the settings; the name's initial otherwise. */
  icon?: string | null
  size?: number
}) {
  return (
    <span
      className="flex shrink-0 items-center justify-center font-bold text-white"
      aria-hidden
      style={{
        width: size,
        height: size,
        borderRadius: Math.round(size * 0.27),
        background: AVATAR_COLOR_HEX[color],
        fontSize: Math.round(size <= 24 ? size * 0.5 : size * 0.43),
      }}
    >
      {icon?.trim() || name.trim().charAt(0).toUpperCase()}
    </span>
  )
}
