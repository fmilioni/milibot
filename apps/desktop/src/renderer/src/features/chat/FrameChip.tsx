import { SquareDashed, X } from 'lucide-react'

import { cn } from '@/lib/cn'

/** The design frame a message is about; removable in the composer. */
export function FrameChip({
  label,
  className = '',
  onRemove,
  removeLabel,
}: {
  label: string
  className?: string
  onRemove?: () => void
  removeLabel?: string
}) {
  return (
    <span
      className={cn(
        'flex items-center gap-1.5 rounded-md bg-accent-soft py-1 text-xs font-semibold text-accent',
        onRemove ? 'pr-1.5 pl-2' : 'px-2',
        className,
      )}
    >
      <SquareDashed size={11} className="shrink-0" aria-hidden />
      <span className="truncate">{label}</span>
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          aria-label={removeLabel}
          className="focus-ring shrink-0 rounded opacity-80 hover:opacity-100"
        >
          <X size={11} />
        </button>
      )}
    </span>
  )
}
