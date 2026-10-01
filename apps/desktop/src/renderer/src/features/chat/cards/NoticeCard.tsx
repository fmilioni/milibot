import type { ReactNode } from 'react'

export type NoticeTone = 'accent' | 'danger' | 'warning'

const NOTICE_BACKGROUND: Record<NoticeTone, string> = {
  accent: 'bg-accent-soft',
  danger: 'bg-danger-tint',
  warning: 'bg-warning-tint',
}

/** A tinted card: icon (or avatar) and its text, with the actions under them on the right. */
export function NoticeCard({
  tone,
  icon,
  actions,
  className = '',
  children,
}: {
  tone: NoticeTone
  icon: ReactNode
  actions?: ReactNode
  className?: string
  children: ReactNode
}) {
  return (
    <div
      className={`flex flex-col gap-2.5 rounded-[10px] px-3 py-2.5 ${NOTICE_BACKGROUND[tone]} ${className}`}
    >
      <div className="flex items-center gap-2.5">
        {icon}
        {children}
      </div>
      {actions && <div className="flex flex-wrap justify-end gap-2 empty:hidden">{actions}</div>}
    </div>
  )
}

/** A notice's title over a secondary line. */
export function NoticeLines({ children }: { children: ReactNode }) {
  return <div className="flex min-w-0 flex-1 flex-col gap-0.5">{children}</div>
}

/** A notice's single line of text. */
export function NoticeText({ children }: { children: ReactNode }) {
  return <span className="min-w-0 flex-1 text-sm text-fg">{children}</span>
}
