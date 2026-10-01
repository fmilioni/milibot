import type { Bot, WorkSessionStatus } from '@milibot/shared'
import { useTranslation } from 'react-i18next'

import {
  botStatusLabel,
  isBusyStatus,
  type StatusDetail,
  waitingForUser,
} from '@/features/bots/lib/bot-status'
import { sessionTone } from '@/features/sessions/lib/session-view'
import { StatusChip } from '@/ui/Tag'

export function SessionStatusChip({ status }: { status: WorkSessionStatus }) {
  const { t } = useTranslation()
  return <StatusChip tone={sessionTone(status)}>{t(`chat.session.status.${status}`)}</StatusChip>
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
