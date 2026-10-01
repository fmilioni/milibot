import type { ReactNode } from 'react'

import { cn } from '@/lib/cn'
import { Tooltip } from '@/ui/Tooltip'

/** Page of the settings screen: centered column with the title aligned to it. */
export function SettingsPage({
  title,
  subtitle,
  actions,
  width = 'regular',
  children,
}: {
  title: string
  subtitle?: ReactNode
  actions?: ReactNode
  /** `narrow` for simple forms, `regular` for data-heavy pages, `wide` for two-column pages. */
  width?: 'narrow' | 'regular' | 'wide'
  children: ReactNode
}) {
  const max = { narrow: 'max-w-[720px]', regular: 'max-w-[880px]', wide: 'max-w-[1104px]' }[width]
  return (
    <div className={`mx-auto flex w-full flex-col gap-3.5 ${max}`}>
      <header className="flex items-start justify-between gap-4 pb-1">
        <div className="flex min-w-0 flex-col gap-1">
          <h1 className="text-5xl leading-[27px] font-bold text-fg">{title}</h1>
          {subtitle && <p className="text-base text-fg-secondary">{subtitle}</p>}
        </div>
        {actions && <div className="no-drag flex shrink-0 items-center gap-2">{actions}</div>}
      </header>
      {children}
    </div>
  )
}

export function SettingsCard({
  title,
  tone = 'default',
  children,
  className = '',
}: {
  title?: ReactNode
  tone?: 'default' | 'danger' | 'highlight'
  children: ReactNode
  className?: string
}) {
  const border =
    tone === 'danger' ? 'border-danger-soft' : tone === 'highlight' ? 'border-warning' : 'border-border'
  return (
    <section className={`flex flex-col rounded-xl border bg-surface-2 ${border} ${className}`}>
      {title && (
        <h2 className="px-4 pt-3.5 pb-1 text-sm leading-4 font-semibold text-fg-secondary">{title}</h2>
      )}
      {children}
    </section>
  )
}

/** Label + hint on the left, control on the right; rows after the first get a divider. */
export function SettingsRow({
  label,
  hint,
  children,
  htmlFor,
  divider = true,
  className = '',
}: {
  label: ReactNode
  hint?: ReactNode
  children?: ReactNode
  htmlFor?: string
  divider?: boolean
  className?: string
}) {
  return (
    <div
      className={cn(
        'settings-row flex min-h-[54px] items-center gap-4 px-4 py-2.5',
        divider && 'border-border [.settings-row+&]:border-t',
        className,
      )}
    >
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        {htmlFor ? (
          <label htmlFor={htmlFor} className="text-base text-fg">
            {label}
          </label>
        ) : (
          <span className="text-base text-fg">{label}</span>
        )}
        {hint && <span className="text-xs leading-[15px] text-fg-muted">{hint}</span>}
      </div>
      {children !== undefined && <div className="flex shrink-0 items-center gap-2">{children}</div>}
    </div>
  )
}

export function Notice({
  icon,
  children,
  tone = 'neutral',
  action,
}: {
  icon: ReactNode
  children: ReactNode
  tone?: 'neutral' | 'warning' | 'danger' | 'success' | 'accent'
  action?: ReactNode
}) {
  const tones = {
    neutral: 'bg-surface-3 text-fg-secondary',
    accent: 'bg-accent-soft text-fg',
    warning: 'bg-warning-tint text-fg',
    danger: 'bg-danger-tint text-fg',
    success: 'bg-success-soft text-fg',
  }
  return (
    <div className={`flex flex-col gap-2.5 rounded-[10px] px-3.5 py-2.5 ${tones[tone]}`}>
      <div className="flex items-center gap-2.5">
        <span className="shrink-0" aria-hidden>
          {icon}
        </span>
        <div className="min-w-0 flex-1 text-sm leading-[17px]">{children}</div>
      </div>
      {action && <div className="flex flex-wrap justify-end gap-2 empty:hidden">{action}</div>}
    </div>
  )
}

export function Stepper({
  value,
  min,
  max,
  onChange,
  label,
  decrementLabel,
  incrementLabel,
  step = 1,
  format,
}: {
  value: number
  min: number
  max: number
  onChange: (value: number) => void
  label: string
  decrementLabel: string
  incrementLabel: string
  step?: number
  format?: (value: number) => string
}) {
  const button =
    'focus-ring flex size-6 items-center justify-center rounded text-md text-fg-secondary hover:bg-surface-3 disabled:opacity-40'
  return (
    <div
      role="group"
      aria-label={label}
      className="flex h-7 items-center gap-1 rounded-lg border border-border px-1"
    >
      <button
        type="button"
        className={button}
        aria-label={decrementLabel}
        disabled={value <= min}
        onClick={() => onChange(Math.max(min, value - step))}
      >
        −
      </button>
      <span
        className={cn(
          format ? 'min-w-6 px-1' : 'w-6',
          'text-center text-base font-semibold text-fg tabular-nums',
        )}
        aria-live="polite"
      >
        {format ? format(value) : value}
      </span>
      <button
        type="button"
        className={button}
        aria-label={incrementLabel}
        disabled={value >= max}
        onClick={() => onChange(Math.min(max, value + step))}
      >
        +
      </button>
    </div>
  )
}

/** Compact text field of the settings forms (providers, credentials, MCP servers). */
export const COMPACT_INPUT =
  'selectable h-[30px] w-full rounded-[7px] border border-border bg-surface px-2.5 text-sm text-fg outline-none placeholder:text-fg-muted focus:border-accent'

/** A failure in the app's words, with the daemon's own message (English, technical) in a tooltip. */
export function ErrorLine({ message, detail }: { message: string; detail?: string | null }) {
  return (
    <Tooltip content={detail && detail !== message ? detail : null} maxWidth={420}>
      <p role="alert" className="selectable w-fit text-sm text-danger">
        {message}
      </p>
    </Tooltip>
  )
}
