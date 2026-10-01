import { CalendarClock } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { describeSchedule, formatDayMonth } from '@/features/bots/lib/routine-schedule'
import type { RoutineCreatedPayload } from '@/features/chat/lib/message-view'

import { NoticeCard, NoticeLines } from './NoticeCard'

export function RoutineCard({ payload, onOpen }: { payload: RoutineCreatedPayload; onOpen?: () => void }) {
  const { t, i18n } = useTranslation()
  const next = payload.nextRunAt ? formatDayMonth(payload.nextRunAt, i18n.language, t) : null
  const schedule = describeSchedule(payload.cron, i18n.language, t)
  return (
    <NoticeCard
      tone="accent"
      icon={<CalendarClock size={14} className="shrink-0 text-accent" />}
      actions={
        onOpen && (
          <button
            type="button"
            onClick={onOpen}
            className="focus-ring shrink-0 rounded text-sm text-accent hover:underline"
          >
            {t('chat.routine.view')}
          </button>
        )
      }
    >
      <NoticeLines>
        <span className="truncate text-base font-semibold text-accent">
          {t('chat.routine.created', { name: payload.name })}
        </span>
        <span className="truncate text-sm text-fg-secondary">
          {next ? t('chat.routine.whenNext', { schedule, next }) : schedule}
        </span>
      </NoticeLines>
    </NoticeCard>
  )
}
