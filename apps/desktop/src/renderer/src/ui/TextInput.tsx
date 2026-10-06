import { Search } from 'lucide-react'
import type { ComponentProps, InputHTMLAttributes, ReactNode } from 'react'

import { cn } from '@/lib/cn'

/** Compact search field with a magnifier (list filters). */
export function SearchInput({
  value,
  onChange,
  placeholder,
  className = '',
}: {
  value: string
  onChange: (value: string) => void
  placeholder: string
  className?: string
}) {
  // The icon is positioned against the input's own box, so callers can pad the outer wrapper.
  return (
    <div className={className}>
      <div className="relative">
        <Search
          size={13}
          className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-fg-muted"
          aria-hidden
        />
        <input
          type="search"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          aria-label={placeholder}
          className="selectable h-[25px] w-full rounded-md border border-border bg-surface-2 pr-2 pl-[29px] text-sm text-fg outline-none placeholder:text-fg-muted focus:border-accent"
        />
      </div>
    </div>
  )
}

export function FieldLabel({
  children,
  hint,
  htmlFor,
}: {
  children: ReactNode
  hint?: ReactNode
  htmlFor?: string
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <label htmlFor={htmlFor} className="text-sm font-medium text-fg-secondary">
        {children}
      </label>
      {hint && <span className="text-xs text-fg-muted">{hint}</span>}
    </div>
  )
}

type Tone = 'surface' | 'surface-2'

const inputBase =
  'selectable w-full rounded-lg border border-border px-3 text-base text-fg outline-none placeholder:text-fg-muted focus:border-accent aria-[invalid=true]:border-danger'

export function TextInput({
  tone = 'surface',
  className = '',
  ...rest
}: InputHTMLAttributes<HTMLInputElement> & { tone?: Tone }) {
  return (
    <input
      className={cn(inputBase, 'h-[34px]', tone === 'surface' ? 'bg-surface' : 'bg-surface-2', className)}
      {...rest}
    />
  )
}

export function TextArea({
  tone = 'surface',
  className = '',
  ...rest
}: ComponentProps<'textarea'> & { tone?: Tone }) {
  return (
    <textarea
      className={cn(
        inputBase,
        'resize-none py-[9px] leading-[1.5]',
        tone === 'surface' ? 'bg-surface' : 'bg-surface-2',
        className,
      )}
      {...rest}
    />
  )
}
