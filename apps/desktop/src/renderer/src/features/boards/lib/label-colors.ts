import type { BoardLabelColor } from '@milibot/shared'

/** Classes of a label color: the chip (soft background, readable text) and a solid dot. */
export const LABEL_COLOR_CLASSES: Record<BoardLabelColor, { chip: string; dot: string }> = {
  gray: { chip: 'bg-zinc-500/15 text-zinc-700 dark:text-zinc-300', dot: 'bg-zinc-500' },
  red: { chip: 'bg-red-500/15 text-red-700 dark:text-red-300', dot: 'bg-red-500' },
  orange: { chip: 'bg-orange-500/15 text-orange-700 dark:text-orange-300', dot: 'bg-orange-500' },
  yellow: { chip: 'bg-yellow-500/20 text-yellow-800 dark:text-yellow-200', dot: 'bg-yellow-500' },
  green: { chip: 'bg-green-500/15 text-green-700 dark:text-green-300', dot: 'bg-green-500' },
  teal: { chip: 'bg-teal-500/15 text-teal-700 dark:text-teal-300', dot: 'bg-teal-500' },
  blue: { chip: 'bg-blue-500/15 text-blue-700 dark:text-blue-300', dot: 'bg-blue-500' },
  violet: { chip: 'bg-violet-500/15 text-violet-700 dark:text-violet-300', dot: 'bg-violet-500' },
  pink: { chip: 'bg-pink-500/15 text-pink-700 dark:text-pink-300', dot: 'bg-pink-500' },
}
