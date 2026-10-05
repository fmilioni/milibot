import { type Board, BOARD_USER, type BoardCard, localDate } from '@milibot/shared'
import { CalendarDays, CalendarPlus, Plus, Tag as TagIcon, UserPlus, Users } from 'lucide-react'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

import { AssigneePicker, LabelChip, LabelPicker, UserAvatar } from '@/features/boards/CardPeople'
import { BotAvatar } from '@/features/bots/avatar/BotAvatar'
import { useAppStore } from '@/features/workspace/store'
import { useNow } from '@/hooks/use-now'
import { cn } from '@/lib/cn'
import { DatePicker } from '@/ui/DatePicker'
import { Tooltip } from '@/ui/Tooltip'

const DASHED_ADD =
  'focus-ring hit flex size-8 shrink-0 items-center justify-center rounded-lg border border-dashed border-fg-muted text-fg-secondary hover:border-fg-secondary hover:text-fg'
const QUIET_ACTION =
  'focus-ring hit flex h-8 items-center gap-1.5 rounded-md px-1 text-base text-fg-secondary hover:text-fg'

function Row({ icon, label, children }: { icon: ReactNode; label: string; children: ReactNode }) {
  return (
    <div className="flex min-h-11 items-start gap-3">
      <span className="flex h-11 w-[124px] shrink-0 items-center gap-2 text-base text-fg-secondary">
        {icon}
        {label}
      </span>
      <div className="flex min-h-11 min-w-0 flex-1 flex-wrap items-center gap-1.5 py-1.5">{children}</div>
    </div>
  )
}

const DAY_MS = 86_400_000

/** Days from `today` to `due` (both `YYYY-MM-DD`), negative when past. */
function daysUntil(due: string, today: string): number {
  return Math.round((Date.parse(`${due}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / DAY_MS)
}

/** Assignees, labels and due date of a card, in the side column. */
export function CardDetails({
  board,
  card,
  onSave,
}: {
  board: Board
  card: BoardCard
  onSave: (patch: { assignees?: string[]; labelIds?: string[]; dueDate?: string | null }) => void
}) {
  const { t, i18n } = useTranslation()
  const bots = useAppStore((s) => s.bots)
  const today = localDate(useNow(60_000))
  const labels = board.labels.filter((l) => card.labelIds.includes(l.id))
  const days = card.dueDate ? daysUntil(card.dueDate, today) : 0
  const open = card.status === 'todo' || card.status === 'doing'
  const dueText = card.dueDate
    ? new Intl.DateTimeFormat(i18n.language, { day: 'numeric', month: 'short', year: 'numeric' })
        .format(new Date(`${card.dueDate}T12:00:00`))
        .replace(/\.$/, '')
        .replaceAll(' de ', ' ')
    : ''
  const relative =
    days === 0
      ? t('boards.card.dueToday')
      : days > 0
        ? t('boards.card.dueIn', { count: days })
        : t('boards.card.dueAgo', { count: -days })

  return (
    <section className="flex flex-col" aria-labelledby="card-details-title">
      <h3
        id="card-details-title"
        className="flex min-h-11 items-center text-sm font-semibold text-fg-secondary"
      >
        {t('boards.card.details')}
      </h3>
      <Row icon={<Users size={16} aria-hidden />} label={t('boards.card.assignees')}>
        {card.assignees.map((id) => {
          const bot = bots[id]
          return (
            <span
              key={id}
              className="flex h-8 max-w-full items-center gap-1.5 rounded-full border border-border bg-surface-2 pr-3 pl-1 text-base text-fg"
            >
              {id === BOARD_USER || !bot ? (
                <UserAvatar size={22} ring />
              ) : (
                <BotAvatar avatar={bot.avatar} state={bot.status} size={22} animated={false} />
              )}
              <span className="truncate">
                {id === BOARD_USER ? t('boards.card.you') : (bot?.name ?? t('boards.card.deletedBot'))}
              </span>
            </span>
          )
        })}
        <AssigneePicker
          value={card.assignees}
          onChange={(assignees) => onSave({ assignees })}
          trigger={(show) =>
            card.assignees.length === 0 ? (
              <button
                type="button"
                aria-haspopup="menu"
                onClick={(e) => show(e.currentTarget)}
                className={QUIET_ACTION}
              >
                <UserPlus size={16} aria-hidden />
                {t('boards.card.assign')}
              </button>
            ) : (
              <Tooltip content={t('boards.card.addAssignee')}>
                <button
                  type="button"
                  aria-haspopup="menu"
                  aria-label={t('boards.card.addAssignee')}
                  onClick={(e) => show(e.currentTarget)}
                  className={DASHED_ADD}
                >
                  <Plus size={16} />
                </button>
              </Tooltip>
            )
          }
        />
      </Row>
      <Row icon={<TagIcon size={16} aria-hidden />} label={t('boards.card.labels')}>
        {labels.map((label) => (
          <LabelChip key={label.id} label={label} size="md" />
        ))}
        <LabelPicker
          board={board}
          value={card.labelIds}
          onChange={(labelIds) => onSave({ labelIds })}
          trigger={(show) => (
            <Tooltip content={t('boards.card.addLabel')}>
              <button
                type="button"
                aria-haspopup="menu"
                aria-label={t('boards.card.addLabel')}
                onClick={(e) => show(e.currentTarget)}
                className={DASHED_ADD}
              >
                <Plus size={16} />
              </button>
            </Tooltip>
          )}
        />
      </Row>
      <Row icon={<CalendarDays size={16} aria-hidden />} label={t('boards.card.due')}>
        <DatePicker
          value={card.dueDate}
          label={t('boards.card.due')}
          onChange={(dueDate) => onSave({ dueDate })}
          className={cn(QUIET_ACTION, card.dueDate && 'text-fg')}
        >
          {card.dueDate ? (
            <span className="flex flex-wrap items-baseline gap-x-1.5">
              <span className="font-medium">{dueText}</span>
              <span
                className={cn(open && days < 0 ? 'font-semibold text-danger-strong' : 'text-fg-secondary')}
              >
                · {relative}
              </span>
            </span>
          ) : (
            <>
              <CalendarPlus size={16} aria-hidden />
              {t('boards.card.setDue')}
            </>
          )}
        </DatePicker>
      </Row>
    </section>
  )
}
