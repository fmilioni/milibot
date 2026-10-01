import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

import { cn } from '@/lib/cn'
import { AsyncView } from '@/ui/AsyncView'

/** Shell of one file's diff: the "truncated" banner, then loading / failed + retry / `children(data)`. */
export function DiffPanel<T>({
  className = '',
  compact = false,
  truncated = false,
  data,
  error,
  onRetry,
  errorText,
  children,
}: {
  className?: string
  /** Smaller banner and paddings (inline in the chat). */
  compact?: boolean
  truncated?: boolean | undefined
  data: T | null | undefined
  error?: unknown
  onRetry?: () => void
  errorText?: string
  children: (data: T) => ReactNode
}) {
  const { t } = useTranslation()
  return (
    <div className={`flex flex-col bg-surface ${className}`}>
      {truncated && (
        <div
          className={cn(
            'border-b border-border bg-warning-tint text-fg-secondary',
            compact ? 'px-3 py-1 text-xs' : 'px-4 py-1.5 text-sm',
          )}
        >
          {t('session.diff.truncated')}
        </div>
      )}
      <AsyncView
        data={data}
        error={error}
        {...(onRetry ? { onRetry } : {})}
        {...(errorText ? { errorText } : {})}
        className={cn(
          'flex items-center justify-center py-4 text-sm text-fg-muted',
          compact ? 'gap-2 px-3' : 'gap-3 px-4',
        )}
      >
        {children}
      </AsyncView>
    </div>
  )
}
