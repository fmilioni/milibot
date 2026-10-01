import { CircleAlert, CircleCheck, Clock, Info } from 'lucide-react'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

import { cn } from '@/lib/cn'
import { Button } from '@/ui/Button'
import { Spinner } from '@/ui/Spinner'
import { Tooltip } from '@/ui/Tooltip'

export type StripTone = 'success' | 'progress' | 'warning' | 'danger' | 'neutral'

const STATUS_ICON: Record<StripTone, ReactNode> = {
  success: <CircleCheck size={13} className="text-success" />,
  progress: <Spinner size={13} className="text-accent" />,
  warning: <Clock size={13} className="text-warning" />,
  danger: <CircleAlert size={13} className="text-danger" />,
  neutral: <Info size={13} className="text-fg-muted" />,
}

/** Status line at the bottom of a settings card: icon, text, optional progress bar and "Try again". */
export function StatusStrip({
  tone,
  text,
  progress,
  error,
  onRetry,
}: {
  tone: StripTone
  text: string
  /** 0..1 */
  progress: number | null
  /** Full error, in a tooltip over the text. */
  error?: string | null
  onRetry?: () => void
}) {
  const { t } = useTranslation()
  const percent = progress === null ? null : Math.round(progress * 100)
  return (
    <div className="flex min-h-[35px] items-center gap-2.5 border-t border-border bg-surface/60 px-4 py-2">
      <span className="flex shrink-0" aria-hidden>
        {STATUS_ICON[tone]}
      </span>
      <Tooltip content={error ?? null} maxWidth={420}>
        <span
          className={cn(
            'min-w-0 flex-1 text-sm leading-[16px]',
            tone === 'danger' ? 'text-danger' : 'text-fg-secondary',
          )}
          aria-live="polite"
        >
          {text}
        </span>
      </Tooltip>
      {percent !== null && (
        <span
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
          aria-label={text}
          className="h-1 w-[140px] shrink-0 overflow-hidden rounded-full bg-surface-3"
        >
          <span
            className="block h-full rounded-full bg-accent transition-[width]"
            style={{ width: `${Math.max(2, percent)}%` }}
          />
        </span>
      )}
      {onRetry && (
        <Button size="sm" variant="outline" onClick={onRetry}>
          {t('common.retry')}
        </Button>
      )}
    </div>
  )
}
