import { BOARD_CARD_STATUSES, type BoardPayload } from '@milibot/shared'
import { Archive, ArchiveRestore, Check, CircleDot, SquareKanban } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { CARD_TONE } from '@/features/boards/lib/boards'
import { toastOnError, useAppStore } from '@/features/workspace/store'
import { cn } from '@/lib/cn'
import { TONE_FILL } from '@/lib/tone'
import { Button } from '@/ui/Button'

import { DueChip } from './BoardParts'
import { useBoardStore } from './store'

/** "Board · <title>" in the chat: status, the count of each column and "Open board". */
export function BoardChatCard({ payload }: { payload: BoardPayload }) {
  const { t } = useTranslation()
  const workspaceId = useAppStore((s) => s.workspaceId)
  const openBoards = useAppStore((s) => s.openBoards)
  const updateBoard = useBoardStore((s) => s.updateBoard)

  if (payload.removed) {
    return (
      <div className="flex items-center gap-2 rounded-[10px] border border-dashed border-border px-3 py-2.5 text-sm text-fg-muted">
        <SquareKanban size={14} className="shrink-0" aria-hidden />
        <span className="truncate line-through">{payload.title}</span>
        <span className="shrink-0">· {t('chat.board.removed')}</span>
      </div>
    )
  }

  const archived = payload.archived === true
  const setArchived = (value: boolean) =>
    workspaceId && void toastOnError(updateBoard(workspaceId, payload.boardId, { archived: value }))
  const chip = archived
    ? {
        icon: <Archive size={11} />,
        text: t('boards.status.archived'),
        className: 'bg-surface-3 text-fg-secondary',
      }
    : payload.status === 'done'
      ? {
          icon: <Check size={11} />,
          text: t('boards.status.done'),
          className: 'bg-success-soft text-success',
        }
      : {
          icon: <CircleDot size={11} />,
          text: t('boards.status.active'),
          className: 'bg-accent-soft text-accent',
        }

  return (
    <div
      className={cn(
        'flex max-w-[560px] flex-col gap-3 rounded-[10px] border border-border bg-surface-2 p-3.5',
        archived && 'opacity-75',
      )}
    >
      <div className="flex items-center gap-2">
        <SquareKanban size={15} className="shrink-0 text-accent" aria-hidden />
        <span className="truncate text-md font-semibold text-fg">{payload.title}</span>
        <span
          className={`flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-xs font-semibold ${chip.className}`}
        >
          {chip.icon}
          {chip.text}
        </span>
      </div>
      {payload.summary && (
        <p className="line-clamp-3 text-base leading-[1.5] text-fg-secondary">{payload.summary}</p>
      )}
      <div className="grid grid-cols-4 gap-2">
        {BOARD_CARD_STATUSES.map((status) => (
          <div
            key={status}
            className="flex flex-col gap-0.5 rounded-lg border border-border bg-surface px-2.5 py-2"
          >
            <span className="flex items-center gap-1.5 text-xs text-fg-secondary">
              <span className={`size-1.5 rounded-full ${TONE_FILL[CARD_TONE[status]]}`} aria-hidden />
              {t(`boards.columns.${status}`)}
            </span>
            <span className="text-xl font-bold text-fg">{payload.counts[status]}</span>
          </div>
        ))}
      </div>
      <div className="flex items-center gap-2">
        {payload.dueDate && <DueChip dueDate={payload.dueDate} status={payload.status} prefix />}
        <span className="flex-1" />
        {payload.status === 'done' && !archived && (
          <Button size="sm" onClick={() => setArchived(true)}>
            <Archive size={13} aria-hidden />
            {t('boards.menu.archive')}
          </Button>
        )}
        {archived && (
          <Button size="sm" onClick={() => setArchived(false)}>
            <ArchiveRestore size={13} aria-hidden />
            {t('boards.menu.unarchive')}
          </Button>
        )}
        <Button
          size="sm"
          variant={archived ? 'secondary' : 'primary'}
          onClick={() => openBoards(payload.boardId)}
        >
          <SquareKanban size={13} aria-hidden />
          {t('chat.board.open')}
        </Button>
      </div>
    </div>
  )
}
