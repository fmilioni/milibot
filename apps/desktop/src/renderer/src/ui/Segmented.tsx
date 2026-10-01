import type { ReactNode } from 'react'

import { cn } from '@/lib/cn'

export interface SegmentedOption<T extends string> {
  value: T
  label: ReactNode
  /** A muted number after the label (items in a filter, files changed). */
  count?: ReactNode
}

type Size = 'md' | 'sm' | 'xs'

const PILL_TRACK: Record<Size, string> = {
  md: 'flex rounded-lg bg-surface-3 p-0.5',
  sm: 'flex gap-0.5 rounded-lg bg-surface-3 p-[3px]',
  xs: 'flex gap-0.5 rounded-md bg-surface-3 p-0.5',
}

const PILL_BUTTON: Record<Size, string> = {
  md: 'flex-1 rounded-md px-3 py-1.5 text-base whitespace-nowrap',
  sm: 'flex h-[25px] items-center gap-1.5 rounded-md px-3 text-sm',
  xs: 'flex items-center gap-1 rounded-[5px] px-2 py-0.5 text-xs',
}

/**
 * One choice out of a few: a pill track (settings switches, filters with counts) or underlined tabs.
 * `role="tab"` for views of the same content, `radio` for a setting.
 */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
  size = 'md',
  variant = 'pill',
  role = 'radio',
  className = '',
}: {
  value: T
  options: SegmentedOption<T>[]
  onChange: (value: T) => void
  label: string
  size?: Size
  variant?: 'pill' | 'underline'
  role?: 'radio' | 'tab'
  className?: string
}) {
  const underline = variant === 'underline'
  return (
    <div
      role={role === 'tab' ? 'tablist' : 'radiogroup'}
      aria-label={label}
      className={cn(underline ? 'flex gap-4 border-b border-border' : PILL_TRACK[size], className)}
    >
      {options.map((option) => {
        const selected = option.value === value
        const look = underline
          ? `flex h-9 items-center gap-1.5 border-b-2 px-1 text-base ${
              selected
                ? 'border-accent font-semibold text-fg'
                : 'border-transparent text-fg-secondary hover:text-fg'
            }`
          : `${PILL_BUTTON[size]} ${
              selected ? 'bg-surface-2 font-semibold text-fg shadow-sm' : 'text-fg-secondary hover:text-fg'
            }`
        return (
          <button
            key={option.value}
            type="button"
            role={role}
            {...(role === 'tab' ? { 'aria-selected': selected } : { 'aria-checked': selected })}
            onClick={() => onChange(option.value)}
            className={`focus-ring ${look}`}
          >
            {option.label}
            {option.count !== undefined && (
              <span className="text-xs font-normal text-fg-muted tabular-nums">{option.count}</span>
            )}
          </button>
        )
      })}
    </div>
  )
}
