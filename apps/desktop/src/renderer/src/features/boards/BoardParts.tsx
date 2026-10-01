import {
  type BoardCardStatus,
  type BoardCounts,
  type BoardStatus,
  isOverdue,
  localDate,
} from '@milibot/shared'
import { CalendarDays } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { boardProgress } from '@/features/boards/lib/boards'
import { useBlobSrc } from '@/features/workspace/use-blob-src'
import { useNow } from '@/hooks/use-now'
import { formatDueDate } from '@/lib/calendar'
import { cn } from '@/lib/cn'
import { ImagePreview } from '@/ui/ImagePreview'

/** The due date, red once past it while still open. */
export function DueChip({
  dueDate,
  status,
  prefix = false,
}: {
  dueDate: string
  status: BoardCardStatus | BoardStatus
  prefix?: boolean
}) {
  const { t, i18n } = useTranslation()
  const today = localDate(useNow(60_000))
  const late = isOverdue({ dueDate, status }, today)
  const text = formatDueDate(dueDate, i18n.language, today)
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-px text-xs font-semibold',
        late ? 'bg-danger-tint text-danger' : 'bg-surface-3 text-fg-secondary',
      )}
      title={late ? t('boards.overdue') : undefined}
    >
      <CalendarDays size={11} aria-hidden />
      {prefix ? t('boards.due', { date: text }) : text}
    </span>
  )
}

/** Done in green and doing in blue over the cards that count. */
export function BoardProgressBar({ counts, className = '' }: { counts: BoardCounts; className?: string }) {
  const { total } = boardProgress(counts)
  const width = (n: number) => `${total ? (n / total) * 100 : 0}%`
  return (
    <div className={`flex h-1.5 overflow-hidden rounded-full bg-surface-3 ${className}`} aria-hidden>
      <div className="h-full bg-success" style={{ width: width(counts.done) }} />
      <div className="h-full bg-accent" style={{ width: width(counts.doing) }} />
    </div>
  )
}

/** An image of a card (a blob), full size on click. */
function AssetImage({ sha, alt }: { sha: string; alt: string }) {
  const src = useBlobSrc(sha)
  const [preview, setPreview] = useState(false)
  if (!src) return <span className="my-1 block h-24 w-40 rounded-lg bg-surface-3" aria-label={alt} />
  return (
    <>
      <button type="button" onClick={() => setPreview(true)} className="focus-ring my-1 block rounded-lg">
        <img
          src={src}
          alt={alt}
          className="max-h-64 max-w-full rounded-lg border border-border object-contain"
        />
      </button>
      {alt && <span className="block text-xs text-fg-muted">{alt}</span>}
      {preview && <ImagePreview src={src} name={alt} onClose={() => setPreview(false)} />}
    </>
  )
}

export const renderAsset = (sha: string, alt: string) => <AssetImage sha={sha} alt={alt} />
