import { type Board } from '@milibot/shared'
import { Archive, ArchiveRestore, FolderKanban, Pencil, SquareKanban, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { boardProgress } from '@/features/boards/lib/boards'
import { BotAvatar } from '@/features/bots/avatar/BotAvatar'
import { useProjectStore } from '@/features/projects/store'
import { useAppStore } from '@/features/workspace/store'
import { useWorkspaceId } from '@/features/workspace/use-workspace-id'
import { ConfirmDialog } from '@/ui/Confirm'
import { MoreMenu } from '@/ui/MoreMenu'
import { StatusChip } from '@/ui/Tag'

import { BoardDialog } from './BoardDialog'
import { BoardProgressBar, DueChip } from './BoardParts'
import { useBoardStore } from './store'

export function BoardHeader({ board }: { board: Board }) {
  const { t } = useTranslation()
  const workspaceId = useWorkspaceId()
  const showToast = useAppStore((s) => s.showToast)
  const bot = useAppStore((s) => (board.botId ? s.bots[board.botId] : undefined))
  const project = useProjectStore((s) =>
    board.projectId ? s.projects.find((p) => p.id === board.projectId) : null,
  )
  const updateBoard = useBoardStore((s) => s.updateBoard)
  const deleteBoard = useBoardStore((s) => s.deleteBoard)
  const [editing, setEditing] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const archived = board.archivedAt !== null
  const progress = boardProgress(board.counts)
  const setArchived = (value: boolean) =>
    void updateBoard(workspaceId, board.id, { archived: value }).catch(() => showToast('error'))

  return (
    <header className="flex shrink-0 flex-col gap-2 px-6 pt-4 pb-4">
      <div className="drag-region flex min-h-8 items-center gap-2.5 win:pr-caption-0">
        <SquareKanban size={18} className="shrink-0 text-accent" aria-hidden />
        <h2 className="truncate text-3xl font-bold text-fg">{board.title}</h2>
        {archived ? (
          <StatusChip tone="neutral">{t('boards.status.archived')}</StatusChip>
        ) : (
          <StatusChip tone={board.status === 'done' ? 'success' : 'accent'}>
            {t(`boards.status.${board.status}`)}
          </StatusChip>
        )}
        {project && (
          <span className="flex shrink-0 items-center gap-1 rounded-md bg-surface-3 px-2 py-0.5 text-xs text-fg-secondary">
            <FolderKanban size={11} aria-hidden />
            {project.name}
          </span>
        )}
        {board.dueDate && <DueChip dueDate={board.dueDate} status={board.status} prefix />}
        <span className="flex-1" />
        <span className="flex shrink-0 items-center gap-1.5 text-xs text-fg-muted">
          {bot && <BotAvatar avatar={bot.avatar} state={bot.status} size={18} animated={false} />}
          {bot ? t('boards.createdBy', { name: bot.name }) : t('boards.createdByUser')}
        </span>
        <span className="no-drag">
          <MoreMenu
            label={t('boards.menu.label', { title: board.title })}
            width={200}
            entries={[
              {
                key: 'edit',
                label: t('boards.menu.edit'),
                icon: <Pencil size={14} />,
                onSelect: () => setEditing(true),
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
        </span>
      </div>
      {board.summary && (
        <p className="selectable max-w-[900px] text-base leading-[1.5] text-fg-secondary">{board.summary}</p>
      )}
      <div className="flex items-center gap-2.5">
        <BoardProgressBar counts={board.counts} className="w-64" />
        <span className="text-sm text-fg-secondary">
          {[
            t('boards.progress', { done: progress.done, total: progress.total }),
            ...(board.counts.doing ? [t('boards.doingCount', { count: board.counts.doing })] : []),
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
