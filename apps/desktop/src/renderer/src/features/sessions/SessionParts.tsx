import type { Bot, WorkSessionStatus } from '@milibot/shared'
import { useTranslation } from 'react-i18next'

import {
  botStatusLabel,
  isBusyStatus,
  type StatusDetail,
  waitingForUser,
} from '@/features/bots/lib/bot-status'
import { type SessionTone, sessionTone } from '@/features/sessions/lib/session-view'
import { cn } from '@/lib/cn'
import { StatusChip } from '@/ui/Tag'

export function SessionStatusChip({ status }: { status: WorkSessionStatus }) {
  const { t } = useTranslation()
  return <StatusChip tone={sessionTone(status)}>{t(`chat.session.status.${status}`)}</StatusChip>
}

// `fg-secondary`, not `fg-muted`: a non-text indicator needs 3:1 against the background.
const DOT_TONE: Record<SessionTone, string> = {
  accent: 'bg-accent',
  success: 'bg-success',
  danger: 'bg-danger',
  muted: 'bg-fg-secondary',
}

/** The status chip shrunk to a dot, for narrow headers. */
export function SessionStatusDot({ status, className }: { status: WorkSessionStatus; className?: string }) {
  const { t } = useTranslation()
  return (
    <span
      role="img"
      aria-label={t(`chat.session.status.${status}`)}
      className={cn('size-2 shrink-0 rounded-full', DOT_TONE[sessionTone(status)], className)}
    />
  )
}

/** What the session's lane is doing right now ("Using the terminal…"), or null while it waits. */
export function useLaneLabel(
  lane: { status: string } | undefined,
  detail: StatusDetail | undefined,
  bots: Record<string, Bot>,
): string | null {
  const { t } = useTranslation()
  if (!lane || !isBusyStatus(lane.status)) return null
  const waiting = waitingForUser(lane.status, detail)
  if (waiting) return t(`bot.waiting.${waiting}`)
  return botStatusLabel(lane.status, detail, t, bots)
}
