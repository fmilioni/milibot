import { cn } from '@/lib/cn'
export function Switch({
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
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        'focus-ring relative h-[18px] w-8 shrink-0 rounded-full p-0.5 transition-colors disabled:opacity-50',
        checked ? 'bg-accent' : 'bg-surface-3',
      )}
    >
      <span
        className={cn(
          'block size-3.5 rounded-full bg-white shadow-sm transition-transform',
          checked && 'translate-x-3.5',
        )}
      />
    </button>
  )
}
