import { X } from 'lucide-react'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

import { Tooltip } from './Tooltip'

/**
 * `compact` is the VM panel header (title row inside the panel padding); `bar` is the 64px header
 * with a bottom border (settings, debug). The close button shows when `onClose` is given.
 */
export function PanelHeader({
  title,
  badge,
  actions,
  variant = 'compact',
  onClose,
}: {
  title: string
  badge?: ReactNode
  actions?: ReactNode
  variant?: 'compact' | 'bar'
  onClose?: () => void
}) {
  const { t } = useTranslation()
  const closeButton = onClose && (
    <Tooltip content={t('panels.close')}>
      <button
        type="button"
        onClick={onClose}
        aria-label={t('panels.close')}
        className="focus-ring rounded text-fg-muted hover:text-fg"
      >
        <X size={15} />
      </button>
    </Tooltip>
  )
  if (variant === 'bar') {
    return (
      <header className="drag-region flex h-16 shrink-0 items-center justify-between border-b border-border px-4 win:pr-caption-4">
        <h2 className="truncate text-lg font-semibold text-fg">{title}</h2>
        <div className="no-drag flex items-center gap-3">
          {actions}
          {closeButton}
        </div>
      </header>
    )
  }
  return (
    <header className="drag-region flex shrink-0 items-center justify-between px-4 pt-4 pb-3.5 win:pr-caption-4">
      <div className="flex h-[19px] min-w-0 items-center gap-2.5">
        <h2 className="truncate text-base font-semibold text-fg">{title}</h2>
        {badge}
      </div>
      <div className="no-drag flex items-center gap-3">
        {actions}
        {closeButton}
      </div>
    </header>
  )
}
