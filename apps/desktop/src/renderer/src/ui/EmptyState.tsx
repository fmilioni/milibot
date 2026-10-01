import type { LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'

/** A screen with nothing to list: icon, title, a hint and an optional action (each optional), centered in the free space. */
export function EmptyState({
  icon: Icon,
  title,
  hint,
  action,
  className = '',
}: {
  icon?: LucideIcon
  title?: string
  hint?: string
  action?: ReactNode
  className?: string
}) {
  return (
    <div className={`flex flex-1 flex-col items-center justify-center gap-3 px-10 text-center ${className}`}>
      {Icon && (
        <span className="flex size-11 items-center justify-center rounded-full bg-accent-soft text-accent">
          <Icon size={20} aria-hidden />
        </span>
      )}
      {title && <h2 className="text-lg font-semibold text-fg">{title}</h2>}
      {hint && <p className="max-w-sm text-base leading-[1.5] text-fg-secondary">{hint}</p>}
      {action}
    </div>
  )
}
