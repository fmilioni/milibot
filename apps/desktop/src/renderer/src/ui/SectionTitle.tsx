import type { ReactNode } from 'react'

/** Small uppercase label over a group of rows; with `icon` or `action` it becomes a row with them around it. */
export function SectionTitle({
  children,
  as: Tag = 'span',
  className = '',
  icon,
  action,
}: {
  children: ReactNode
  as?: 'span' | 'h3' | 'div'
  className?: string
  icon?: ReactNode
  action?: ReactNode
}) {
  const title = (
    <Tag
      className={`text-2xs leading-3 font-semibold tracking-[0.08em] text-fg-muted uppercase ${className}`}
    >
      {children}
    </Tag>
  )
  if (!icon && !action) return title
  return (
    <div className="flex items-center gap-1.5 text-fg-muted">
      {icon}
      {title}
      <span className="flex-1" />
      {action}
    </div>
  )
}
