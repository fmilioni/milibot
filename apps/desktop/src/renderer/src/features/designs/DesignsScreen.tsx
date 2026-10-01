import { type Design, foldText } from '@milibot/shared'
import {
  Archive,
  ArchiveRestore,
  Maximize2,
  MessageSquare,
  Pencil,
  PenTool,
  Search,
  Trash2,
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { BotAvatar } from '@/features/bots/avatar/BotAvatar'
import { useDesignStore } from '@/features/canvas/store'
import { conversationName } from '@/features/knowledge/lib/knowledge'
import { useAppStore } from '@/features/workspace/store'
import { useBlobSrc } from '@/features/workspace/use-blob-src'
import { useWorkspaceId } from '@/features/workspace/use-workspace-id'
import { cn } from '@/lib/cn'
import { formatListTime } from '@/lib/format'
import { EmptyState } from '@/ui/EmptyState'
import { MoreMenu } from '@/ui/MoreMenu'
import { Segmented } from '@/ui/Segmented'
import { SearchInput } from '@/ui/TextInput'

import { DeleteDesignDialog } from './DeleteDesignDialog'
import { RenameDesignDialog } from './RenameDesignDialog'

type DesignFilter = 'active' | 'archived'

/** Every design of the workspace, newest first; a click opens its canvas. */
export function DesignsScreen() {
  const { t } = useTranslation()
  const workspaceId = useWorkspaceId()
  const showToast = useAppStore((s) => s.showToast)
  const designs = useDesignStore((s) => (s.workspaceId === workspaceId ? s.designs : null))
  const loaded = useDesignStore((s) => s.workspaceId === workspaceId && s.allLoaded)
  const loadAll = useDesignStore((s) => s.loadAll)
  const [filter, setFilter] = useState<DesignFilter>('active')
  const [query, setQuery] = useState('')
  const [renaming, setRenaming] = useState<Design | null>(null)
  const [deleting, setDeleting] = useState<Design | null>(null)

  useEffect(() => {
    void loadAll(workspaceId).catch(() => showToast('error'))
  }, [loadAll, workspaceId, showToast])

  const all = useMemo(() => Object.values(designs ?? {}).sort((a, b) => b.updatedAt - a.updatedAt), [designs])
  const needle = foldText(query.trim())
  const matching = needle ? all.filter((d) => foldText(d.name).includes(needle)) : all
  const counts = {
    active: matching.filter((d) => d.archivedAt === null).length,
    archived: matching.filter((d) => d.archivedAt !== null).length,
  }
  const listed = matching.filter((d) => (filter === 'archived') === (d.archivedAt !== null))
  const frames = all.reduce((sum, d) => sum + d.frameCount, 0)

  return (
    <main className="flex min-w-0 flex-1 flex-col bg-bg" aria-label={t('designs.title')}>
      <header className="drag-region flex shrink-0 flex-col gap-[18px] px-10 pt-7 pb-5 win:pr-caption-10">
        <div className="flex items-center gap-4">
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <h1 className="text-4xl font-bold text-fg">{t('designs.title')}</h1>
            <p className="text-base text-fg-secondary">{t('designs.subtitle')}</p>
          </div>
          <SearchInput
            value={query}
            onChange={setQuery}
            placeholder={t('designs.search')}
            className="no-drag w-[260px] shrink-0"
          />
        </div>
        <div className="flex items-center gap-3">
          <Segmented
            size="sm"
            role="tab"
            value={filter}
            onChange={setFilter}
            label={t('designs.title')}
            className="no-drag"
            options={(['active', 'archived'] as const).map((value) => ({
              value,
              label: t(`designs.filters.${value}`),
              count: counts[value],
            }))}
          />
          <span className="flex-1" />
          {loaded && all.length > 0 && (
            <span className="text-sm text-fg-muted">
              {t('designs.total', { count: all.length, frames: t('canvas.frames', { count: frames }) })}
            </span>
          )}
        </div>
      </header>

      <div className="scroll-slim flex min-h-0 flex-1 flex-col overflow-y-auto px-10 pb-8">
        {loaded && all.length === 0 ? (
          <EmptyState icon={PenTool} title={t('designs.empty.title')} hint={t('designs.empty.hint')} />
        ) : loaded && listed.length === 0 ? (
          needle ? (
            <EmptyState
              icon={Search}
              title={t('designs.emptySearch.title')}
              hint={t('designs.emptySearch.hint')}
            />
          ) : (
            <EmptyState
              icon={filter === 'archived' ? Archive : PenTool}
              title={t(`designs.emptyFilter.${filter}.title`)}
              hint={t(`designs.emptyFilter.${filter}.hint`)}
            />
          )
        ) : (
          <ul
            className="grid gap-5 [grid-template-columns:repeat(auto-fill,minmax(280px,1fr))]"
            aria-label={t('designs.title')}
          >
            {listed.map((design) => (
              <DesignTile
                key={design.id}
                design={design}
                onRename={() => setRenaming(design)}
                onDelete={() => setDeleting(design)}
              />
            ))}
          </ul>
        )}
      </div>

      {renaming && (
        <RenameDesignDialog
          workspaceId={workspaceId}
          designId={renaming.id}
          name={renaming.name}
          onClose={() => setRenaming(null)}
        />
      )}
      {deleting && (
        <DeleteDesignDialog
          workspaceId={workspaceId}
          designId={deleting.id}
          name={deleting.name}
          onClose={() => setDeleting(null)}
        />
      )}
    </main>
  )
}

function DesignTile({
  design,
  onRename,
  onDelete,
}: {
  design: Design
  onRename: () => void
  onDelete: () => void
}) {
  const { t, i18n } = useTranslation()
  const workspaceId = useWorkspaceId()
  const showToast = useAppStore((s) => s.showToast)
  const openCanvas = useAppStore((s) => s.openCanvas)
  const openConversation = useAppStore((s) => s.openConversation)
  const bot = useAppStore((s) => (design.botId ? s.bots[design.botId] : undefined))
  const conversation = useAppStore((s) =>
    design.conversationId ? s.conversations[design.conversationId] : undefined,
  )
  const bots = useAppStore((s) => s.bots)
  const where = conversationName(conversation, bots)
  const archiveDesign = useDesignStore((s) => s.archiveDesign)
  const src = useBlobSrc(design.thumbnailSha ?? undefined)
  const archived = design.archivedAt !== null

  const open = () => void openCanvas(design.id, design.conversationId).catch(() => showToast('error'))
  const setArchived = (value: boolean) =>
    void archiveDesign(workspaceId, design.id, value).catch(() => showToast('error'))

  return (
    <li className="group relative flex flex-col overflow-hidden rounded-xl border border-border bg-surface hover:border-accent">
      <button
        type="button"
        onClick={open}
        aria-label={t('canvas.openDesign', { name: design.name })}
        className={cn(
          'focus-inset relative block h-[168px] w-full overflow-hidden bg-surface-3',
          archived && 'opacity-60',
        )}
      >
        {src ? (
          <img src={src} alt="" className="size-full object-cover object-top" draggable={false} />
        ) : (
          <span className="flex size-full items-center justify-center text-fg-muted">
            <PenTool size={22} aria-hidden />
          </span>
        )}
        <span className="absolute top-3 left-3 flex items-center gap-1.5 rounded-[7px] bg-surface px-2.5 py-[5px] text-sm font-semibold text-fg opacity-0 shadow-sm group-hover:opacity-100">
          <Maximize2 size={12} aria-hidden />
          {t('designs.openCanvas')}
        </span>
      </button>
      <div className="flex items-center gap-2.5 border-t border-border py-3 pr-3 pl-3.5">
        {bot && <BotAvatar avatar={bot.avatar} state={bot.status} size={20} className="shrink-0" />}
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate text-base font-semibold text-fg" title={design.name}>
            {design.name}
          </span>
          <span className="truncate text-xs text-fg-muted">
            {[
              bot?.name,
              t('canvas.frames', { count: design.frameCount }),
              formatListTime(design.updatedAt, i18n.language, t),
            ]
              .filter(Boolean)
              .join(' · ')}
          </span>
        </div>
        <MoreMenu
          label={t('canvas.moreOptions', { name: design.name })}
          width={200}
          entries={[
            {
              key: 'chat',
              label: t('designs.goToChat'),
              icon: <MessageSquare size={14} />,
              disabled: !where || !design.conversationId,
              onSelect: () =>
                void openConversation(design.conversationId as string).catch(() => showToast('error')),
            },
            {
              key: 'rename',
              label: t('canvas.rename.action'),
              icon: <Pencil size={14} />,
              onSelect: onRename,
            },
            archived
              ? {
                  key: 'unarchive',
                  label: t('canvas.archive.unarchive'),
                  icon: <ArchiveRestore size={14} />,
                  onSelect: () => setArchived(false),
                }
              : {
                  key: 'archive',
                  label: t('canvas.archive.action'),
                  icon: <Archive size={14} />,
                  onSelect: () => setArchived(true),
                },
            { type: 'separator', key: 'sep' },
            {
              key: 'delete',
              label: t('canvas.delete.action'),
              icon: <Trash2 size={14} />,
              danger: true,
              onSelect: onDelete,
            },
          ]}
        />
      </div>
    </li>
  )
}
