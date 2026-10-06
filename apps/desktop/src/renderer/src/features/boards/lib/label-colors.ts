import type { BoardLabelColor } from '@milibot/shared'

/**
 * Classes of a label color: the chip (tint with text that keeps AA in both themes, from the `--label-*` tokens)
 * and a solid dot.
 */
export const LABEL_COLOR_CLASSES: Record<BoardLabelColor, { chip: string; dot: string }> = {
  gray: { chip: 'bg-label-gray-bg text-label-gray', dot: 'bg-label-gray-dot' },
  red: { chip: 'bg-label-red-bg text-label-red', dot: 'bg-label-red-dot' },
  orange: { chip: 'bg-label-orange-bg text-label-orange', dot: 'bg-label-orange-dot' },
  yellow: { chip: 'bg-label-yellow-bg text-label-yellow', dot: 'bg-label-yellow-dot' },
  green: { chip: 'bg-label-green-bg text-label-green', dot: 'bg-label-green-dot' },
  teal: { chip: 'bg-label-teal-bg text-label-teal', dot: 'bg-label-teal-dot' },
  blue: { chip: 'bg-label-blue-bg text-label-blue', dot: 'bg-label-blue-dot' },
  violet: { chip: 'bg-label-violet-bg text-label-violet', dot: 'bg-label-violet-dot' },
  pink: { chip: 'bg-label-pink-bg text-label-pink', dot: 'bg-label-pink-dot' },
}
