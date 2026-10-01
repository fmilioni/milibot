import { AVATAR_COLOR_HEX, AVATAR_COLORS, type AvatarColor } from '@milibot/shared'

import { Tooltip } from './Tooltip'

export function ColorSwatches({
  value,
  onChange,
  label,
  colorLabel,
  size = 22,
  gap = 10,
}: {
  value: AvatarColor
  onChange: (color: AvatarColor) => void
  label: string
  colorLabel: (color: AvatarColor) => string
  size?: number
  gap?: number
}) {
  const order: AvatarColor[] = [
    'brown',
    'red',
    'orange',
    'amber',
    'green',
    'teal',
    'blue',
    'violet',
    'pink',
    'gray',
  ]
  return (
    <div role="radiogroup" aria-label={label} className="flex items-center" style={{ gap }}>
      {order
        .filter((c) => AVATAR_COLORS.includes(c))
        .map((color) => {
          const selected = color === value
          return (
            <Tooltip key={color} content={colorLabel(color)}>
              <button
                type="button"
                role="radio"
                aria-checked={selected}
                aria-label={colorLabel(color)}
                onClick={() => onChange(color)}
                className="focus-ring flex items-center justify-center rounded-full"
                style={{
                  width: selected ? size + 6 : size,
                  height: selected ? size + 6 : size,
                  boxShadow: selected ? `inset 0 0 0 2px ${AVATAR_COLOR_HEX[color]}` : undefined,
                }}
              >
                <span
                  className="block rounded-full"
                  style={{
                    width: selected ? size - 2 : size,
                    height: selected ? size - 2 : size,
                    background: AVATAR_COLOR_HEX[color],
                  }}
                />
              </button>
            </Tooltip>
          )
        })}
    </div>
  )
}
