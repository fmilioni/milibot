import type { ButtonHTMLAttributes } from 'react'

import { cn } from '@/lib/cn'

type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'danger-outline' | 'outline' | 'ghost'

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bg-accent text-on-accent hover:brightness-105',
  secondary: 'bg-surface-3 text-fg hover:brightness-95 dark:hover:brightness-110',
  danger: 'bg-danger text-white hover:brightness-105',
  'danger-outline': 'border border-danger-soft text-danger hover:bg-danger/5',
  outline: 'border border-border bg-surface-2 text-fg hover:bg-surface-3',
  ghost: 'text-fg-secondary hover:bg-surface-3',
}

export function Button({
  variant = 'secondary',
  size = 'md',
  className = '',
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: 'sm' | 'md' | 'lg' }) {
  return (
    <button
      type="button"
      className={cn(
        'focus-ring inline-flex shrink-0 items-center justify-center gap-1.5 font-semibold transition disabled:opacity-50',
        size === 'sm'
          ? 'h-[27px] rounded-[7px] px-3 text-sm'
          : size === 'lg'
            ? 'h-11 rounded-lg px-4 text-base'
            : 'h-8 rounded-lg px-3.5 text-base',
        BUTTON_VARIANTS[variant],
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  )
}

/** Text-only action inside a line of text ("Try again", "View"). */
export function LinkButton({ className = '', children, ...rest }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      className={`focus-ring shrink-0 rounded text-sm font-semibold text-accent hover:underline disabled:opacity-50 ${className}`}
      {...rest}
    >
      {children}
    </button>
  )
}
