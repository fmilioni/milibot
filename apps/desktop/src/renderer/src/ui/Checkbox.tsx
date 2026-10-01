import { Check } from 'lucide-react'

import { cn } from '@/lib/cn'

export function Checkbox({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean
  onChange: (checked: boolean) => void
  label: string
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        'focus-ring flex size-4 shrink-0 items-center justify-center rounded-[4px] border disabled:opacity-50',
        checked ? 'border-accent bg-accent text-on-accent' : 'border-fg-muted/60 bg-surface-2',
      )}
    >
      {checked && <Check size={11} strokeWidth={3} />}
    </button>
  )
}
