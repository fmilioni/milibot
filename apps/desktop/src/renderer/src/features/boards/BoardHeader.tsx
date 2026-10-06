import { type Board } from '@milibot/shared'
import {
  Archive,
  ArchiveRestore,
  CalendarDays,
  Copy,
  Folder,
  PanelLeftOpen,
  Pencil,
  Trash2,
  User,
} from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { boardProgress } from '@/features/boards/lib/boards'
import { BotAvatar } from '@/features/bots/avatar/BotAvatar'
import { useProjectStore } from '@/features/projects/store'
import { copyWithToast, useAppStore } from '@/features/workspace/store'
import { useWorkspaceId } from '@/features/workspace/use-workspace-id'
import { useNow } from '@/hooks/use-now'
import { formatDueDate } from '@/lib/calendar'
import { cn } from '@/lib/cn'
import { ConfirmDialog } from '@/ui/Confirm'
import { MoreMenu } from '@/ui/MoreMenu'
import { Tooltip } from '@/ui/Tooltip'

import { BoardDialog } from './BoardDialog'
import { BoardProgressBar } from './BoardParts'
import { useBoardStore } from './store'

const CHIP = 'flex h-6 shrink-0 items-center gap-1.5 rounded-full px-2.5 text-sm'

export function BoardHeader({ board }: { board: Board }) {
  const { t, i18n } = useTranslation()
  const workspaceId = useWorkspaceId()
  const showToast = useAppStore((s) => s.showToast)
  const bot = useAppStore((s) => (board.botId ? s.bots[board.botId] : undefined))
  const project = useProjectStore((s) =>
    board.projectId ? s.projects.find((p) => p.id === board.projectId) : null,
  )
  const updateBoard = useBoardStore((s) => s.updateBoard)
  const deleteBoard = useBoardStore((s) => s.deleteBoard)
  const listCollapsed = useBoardStore((s) => s.listCollapsed)
  const setListCollapsed = useBoardStore((s) => s.setListCollapsed)
  const today = new Date(useNow(60_000))
  const [editing, setEditing] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const archived = board.archivedAt !== null
  const progress = boardProgress(board.counts)
  const percent = progress.total ? Math.round((progress.done / progress.total) * 100) : 0
  const setArchived = (value: boolean) =>
    void updateBoard(workspaceId, board.id, { archived: value }).catch(() => showToast('error'))
  const created = new Intl.DateTimeFormat(i18n.language, { day: '2-digit', month: '2-digit' }).format(
    board.createdAt,
  )
  const todayIso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
  const late = board.dueDate !== null && board.status === 'active' && board.dueDate < todayIso

  return (
    <header className="flex shrink-0 flex-col gap-3 px-5 pt-5 pb-4">
      <div className="drag-region flex min-h-7 items-center gap-2 win:pr-caption-0">
        {listCollapsed && (
          <>
            <button
              type="button"
              aria-label={t('boards.list.expand')}
              onClick={() => setListCollapsed(false)}
              className="no-drag focus-ring hit flex h-7 shrink-0 items-center gap-1.5 rounded-lg px-1.5 text-sm text-fg-secondary hover:bg-surface-3 hover:text-fg"
            >
              <PanelLeftOpen size={15} aria-hidden />
              {t('boards.list.show')}
            </button>
            <span className="mx-1 h-5 w-px shrink-0 bg-border" aria-hidden />
          </>
        )}
        {archived ? (
          <span className={cn(CHIP, 'bg-surface-3 font-semibold text-fg-secondary')}>
            <Archive size={12} aria-hidden />
            {t('boards.status.archived')}
          </span>
        ) : (
          <span
            className={cn(
              CHIP,
              'font-semibold',
              board.status === 'done'
                ? 'bg-success-soft text-success-strong'
                : 'bg-accent-soft text-accent-strong',
            )}
          >
            <span
              className={cn('size-1.5 rounded-full', board.status === 'done' ? 'bg-success' : 'bg-accent')}
              aria-hidden
            />
            {t(`boards.status.${board.status}`)}
          </span>
        )}
        {project && (
          <span className={cn(CHIP, 'min-w-0 bg-surface-3 text-fg-secondary')}>
            <Folder size={13} className="shrink-0" aria-hidden />
            <span className="truncate">{project.name}</span>
          </span>
        )}
        {board.dueDate && (
          <span
            className={cn(
              CHIP,
              late ? 'bg-danger-tint font-semibold text-danger-strong' : 'bg-surface-3 text-fg-secondary',
            )}
            title={late ? t('boards.overdue') : undefined}
          >
            <CalendarDays size={13} aria-hidden />
            {t('boards.until', { date: formatDueDate(board.dueDate, i18n.language, todayIso) })}
          </span>
        )}
        <span className="flex-1" />
        <span className="flex min-w-0 shrink items-center gap-1.5 text-sm text-fg-secondary">
          {bot ? (
            <BotAvatar avatar={bot.avatar} state={bot.status} size={18} animated={false} />
          ) : (
            <span className="flex size-[18px] shrink-0 items-center justify-center rounded-full bg-accent-soft text-accent-strong">
              <User size={11} aria-hidden />
            </span>
          )}
          <span className="truncate">
            {bot
              ? t('boards.createdOn', { name: bot.name, date: created })
              : t('boards.createdOnUser', { date: created })}
          </span>
        </span>
        <MoreMenu
          size="md"
          className="no-drag"
          label={t('boards.menu.label', { title: board.title })}
          width={200}
          entries={[
            {
              key: 'edit',
              label: t('boards.menu.edit'),
              icon: <Pencil size={14} />,
              onSelect: () => setEditing(true),
            },
            {
              key: 'copy-id',
              label: t('boards.menu.copyId'),
              icon: <Copy size={14} />,
              onSelect: () => copyWithToast(board.id, 'idCopied'),
            },
            archived
              ? {
                  key: 'unarchive',
                  label: t('boards.menu.unarchive'),
                  icon: <ArchiveRestore size={14} />,
                  onSelect: () => setArchived(false),
                }
              : {
                  key: 'archive',
                  label: t('boards.menu.archive'),
                  icon: <Archive size={14} />,
                  onSelect: () => setArchived(true),
                },
            { type: 'separator', key: 'sep' },
            {
              key: 'delete',
              label: t('boards.menu.delete'),
              icon: <Trash2 size={14} />,
              danger: true,
              onSelect: () => setDeleting(true),
            },
          ]}
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <h2 className="selectable line-clamp-2 text-6xl leading-tight font-bold text-fg">{board.title}</h2>
        {board.summary && (
          <Tooltip content={board.summary} maxWidth={480}>
            <p className="selectable line-clamp-2 max-w-[660px] text-md leading-[1.5] text-fg-secondary">
              {board.summary}
            </p>
          </Tooltip>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <BoardProgressBar counts={board.counts} className="w-[220px]" />
        <span className="text-sm text-fg-secondary">
          <span className="font-semibold text-fg">
            {t('boards.progress', { done: progress.done, total: progress.total })}
          </span>
          {[
            '',
            ...(progress.done ? [t('boards.progressDetail', { percent })] : []),
            board.counts.doing
              ? t('boards.doingCount', { count: board.counts.doing })
              : t('boards.nothingDoing'),
            ...(board.counts.dropped ? [t('boards.droppedCount', { count: board.counts.dropped })] : []),
          ].join(' · ')}
        </span>
      </div>
      {editing && <BoardDialog board={board} onClose={() => setEditing(false)} />}
      {deleting && (
        <ConfirmDialog
          title={t('boards.delete.title', { title: board.title })}
          description={t('boards.delete.description')}
          confirmLabel={t('boards.delete.confirm')}
          onConfirm={() => deleteBoard(workspaceId, board.id)}
          onClose={() => setDeleting(false)}
        />
      )}
    </header>
  )
}
