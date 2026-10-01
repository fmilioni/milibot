import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

import { LinkButton } from './Button'
import { Spinner } from './Spinner'

/**
 * Spinner while loading, a "failed · Try again" line on error, otherwise `children(data)`. Data already
 * loaded stays on screen during a reload.
 */
export function AsyncView<T>({
  data,
  error,
  onRetry,
  errorText,
  className = 'flex items-center justify-center gap-2 py-6 text-sm text-fg-muted',
  children,
}: {
  data: T | null | undefined
  error?: unknown
  onRetry?: () => void
  errorText?: string
  className?: string
  children: (data: T) => ReactNode
}) {
  const { t } = useTranslation()
  if (data !== null && data !== undefined) return children(data)
  if (error)
    return (
      <div className={className} role="alert">
        <span>{errorText ?? t('toast.error')}</span>
        {onRetry && <LinkButton onClick={onRetry}>{t('common.retry')}</LinkButton>}
      </div>
    )
  return (
    <div className={className}>
      <Spinner size={16} label={t('common.loading')} />
    </div>
  )
}

/** Full-screen stand-in for a screen whose content is loading or could not be found. */
export function ScreenPlaceholder({
  failed,
  message,
  action,
}: {
  failed: boolean
  /** Shown when `failed`. */
  message: string
  /** A way out when `failed` ("Back to the chat"). */
  action?: { label: string; onClick: () => void }
}) {
  const { t } = useTranslation()
  return (
    <main className="flex min-w-0 flex-1 flex-col bg-bg">
      <div className="drag-region h-16 shrink-0 border-b border-border" />
      <div className="flex flex-1 flex-col items-center justify-center gap-3 text-base text-fg-muted">
        {failed ? (
          <>
            <span>{message}</span>
            {action && <LinkButton onClick={action.onClick}>{action.label}</LinkButton>}
          </>
        ) : (
          <Spinner size={16} label={t('common.loading')} />
        )}
      </div>
    </main>
  )
}
