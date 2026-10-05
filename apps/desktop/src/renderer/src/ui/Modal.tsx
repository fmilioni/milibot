import { X } from 'lucide-react'
import { type ReactNode, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'

import { cn } from '@/lib/cn'

import { handleDialogKeys } from './dialog-keys'
import { Tooltip } from './Tooltip'

interface ModalProps {
  title: string
  description?: string
  width: number
  /** A fixed height (still capped by the window) for content that scrolls inside its own panes. */
  height?: number
  onClose: () => void
  /** Defaults to "Close". */
  closeLabel?: string
  showClose?: boolean
  /** Shown in a tinted circle before the title. */
  icon?: ReactNode
  /** False hides the title row (the title still names the dialog for screen readers). */
  header?: boolean
  /** Right-aligned buttons under the content. */
  footer?: ReactNode
  /** False drops the padding and gaps (content that brings its own layout). */
  padded?: boolean
  children: ReactNode
}

export function Modal({
  title,
  description,
  width,
  height,
  onClose,
  closeLabel,
  showClose = true,
  icon,
  header = true,
  footer,
  padded = true,
  children,
}: ModalProps) {
  const { t } = useTranslation()
  const close = closeLabel ?? t('common.close')
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    const first =
      ref.current?.querySelector<HTMLElement>('[data-autofocus]') ??
      ref.current?.querySelector<HTMLElement>('input, textarea, select, button')
    first?.focus()
    return () => previous?.focus?.()
  }, [])

  return createPortal(
    <div
      className="no-drag fixed inset-0 z-modal flex items-center justify-center bg-scrim p-6"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        ref={ref}
        role="dialog"
        aria-modal
        aria-label={title}
        onKeyDown={(event) => handleDialogKeys(event, ref.current, onClose)}
        className={cn(
          'flex max-h-full max-w-full flex-col overflow-y-auto rounded-2xl border border-border bg-surface-2 shadow-[0_20px_50px_rgba(0,0,0,0.25)]',
          padded && 'gap-4 p-6',
        )}
        style={{ width, height }}
      >
        {header && (
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between gap-4">
              <div className="flex min-w-0 items-center gap-3">
                {icon && (
                  <span
                    className="flex size-9 shrink-0 items-center justify-center rounded-full bg-accent-soft text-accent"
                    aria-hidden
                  >
                    {icon}
                  </span>
                )}
                <h2 className="text-3xl leading-[22px] font-bold text-fg">{title}</h2>
              </div>
              {showClose && (
                <Tooltip content={close}>
                  <button
                    type="button"
                    onClick={onClose}
                    aria-label={close}
                    className="focus-ring -mr-1 flex size-6 items-center justify-center rounded-md text-fg-muted hover:bg-surface-3"
                  >
                    <X size={14} />
                  </button>
                </Tooltip>
              )}
            </div>
            {description && <p className="text-base leading-[1.5] text-fg-secondary">{description}</p>}
          </div>
        )}
        {children}
        {footer && <div className="flex justify-end gap-2">{footer}</div>}
      </div>
    </div>,
    document.body,
  )
}
