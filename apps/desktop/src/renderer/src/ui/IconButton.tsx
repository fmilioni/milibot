import type { ButtonHTMLAttributes, ReactNode } from 'react'

import { cn } from '@/lib/cn'

import { Tooltip } from './Tooltip'

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** A toggle's state (sets `aria-pressed`); leave undefined for a plain action. */
  active?: boolean
  label: string
  children: ReactNode
}

export function IconButton({ active, label, children, className = '', ...rest }: IconButtonProps) {
  return (
    <Tooltip content={label}>
      <button
        type="button"
        aria-label={label}
        aria-pressed={active}
        className={cn(
          'no-drag flex size-8 shrink-0 items-center justify-center rounded-lg transition-colors',
          active ? 'bg-accent-soft text-accent' : 'text-fg-secondary hover:bg-surface-3',
          className,
        )}
        {...rest}
      >
        {children}
      </button>
    </Tooltip>
  )
}
