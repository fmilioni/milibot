import { X } from 'lucide-react'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

import { Tooltip } from './Tooltip'

/**
 * `compact` is the VM panel header (title row inside the panel padding); `bar` is the 64px header
 * with a bottom border (settings, debug). The close button shows when `onClose` is given.
 *
 * In a `bar`, `subtitle` follows the title and is the part cut short, and `tabs` sit before the actions,
 * dropping to a full-width second line when the panel is narrower than 420px.
 */
export function PanelHeader({
  title,
  subtitle,
  badge,
  tabs,
  actions,
  variant = 'compact',
  onClose,
}: {
  title: string
  subtitle?: string
  badge?: ReactNode
  tabs?: ReactNode
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
      <header className="drag-region @container shrink-0 border-b border-border">
        <div className="flex min-h-16 items-center gap-3 px-4 win:pr-caption-4 @max-[420px]:flex-wrap @max-[420px]:gap-y-3 @max-[420px]:py-3">
          <h2 className="flex min-w-0 flex-1 text-lg font-semibold whitespace-nowrap text-fg">
            {subtitle ? (
              <>
                <span className="shrink-0">{title}</span>
                <span className="min-w-0 truncate @max-[420px]:pl-1.5 @max-[420px]:text-base @max-[420px]:font-normal @max-[420px]:text-fg-secondary">
                  <span aria-hidden>{'\u00a0·\u00a0'}</span>
                  {subtitle}
                </span>
              </>
            ) : (
              <span className="truncate">{title}</span>
            )}
          </h2>
          {tabs && (
            <div className="no-drag flex @max-[420px]:order-last @max-[420px]:basis-full @max-[420px]:*:flex-1 @max-[420px]:*:*:flex-1 @max-[420px]:*:*:justify-center">
              {tabs}
            </div>
          )}
          <div className="no-drag flex items-center gap-3">
            {actions}
            {closeButton}
          </div>
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
