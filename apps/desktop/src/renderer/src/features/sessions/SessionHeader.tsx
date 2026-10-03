import type { Bot, ModelChoice, WorkSessionDetail } from '@milibot/shared'
import {
  ArrowLeft,
  Bug,
  Copy,
  Cpu,
  Ellipsis,
  FolderGit2,
  GitBranch,
  Layers,
  Monitor,
  Square,
  Trash2,
} from 'lucide-react'
import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { BotAvatar } from '@/features/bots/avatar/BotAvatar'
import { describeConversation } from '@/features/chat/lib/conversation'
import { useProjectStore } from '@/features/projects/store'
import { effortLabel } from '@/features/providers/lib/models'
import { findCatalogModel, useModelCatalog } from '@/features/providers/use-model-catalog'
import { isSessionFinished } from '@/features/sessions/lib/session-view'
import { copyWithToast, useAppStore } from '@/features/workspace/store'
import { useWorkspaceId } from '@/features/workspace/use-workspace-id'
import { cn } from '@/lib/cn'
import { formatUsd } from '@/lib/format'
import { ConfirmDialog } from '@/ui/Confirm'
import { DiffStat } from '@/ui/diff/DiffStat'
import { IconButton } from '@/ui/IconButton'
import { Menu } from '@/ui/Menu'
import { Spinner } from '@/ui/Spinner'
import { Tooltip } from '@/ui/Tooltip'

import { SessionStatusChip, useLaneLabel } from './SessionParts'
import { useSessionStore } from './store'

export function SessionHeader({
  session,
  bot,
  bots,
}: {
  session: WorkSessionDetail
  bot: Bot | undefined
  bots: Record<string, Bot>
}) {
  const { t, i18n } = useTranslation()
  const workspaceId = useWorkspaceId()
  const closeWorkSession = useAppStore((s) => s.closeWorkSession)
  const showToast = useAppStore((s) => s.showToast)
  const debugOpen = useAppStore((s) => s.rightPanel === 'debug')
  const vmOpen = useAppStore((s) => s.rightPanel === 'vm')
  const toggleRightPanel = useAppStore((s) => s.toggleRightPanel)
  const origin = useAppStore((s) => s.conversations[session.originConversationId])
  const laneDetail = useSessionStore((s) => s.laneDetail[session.id])
  const stop = useSessionStore((s) => s.stop)
  const remove = useSessionStore((s) => s.remove)
  const project = useProjectStore((s) =>
    session.projectId ? s.projects.find((p) => p.id === session.projectId) : undefined,
  )
  const [stopping, setStopping] = useState(false)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const menuButton = useRef<HTMLButtonElement>(null)
  const finished = isSessionFinished(session.status)
  const doing = useLaneLabel(finished ? undefined : session.lane, laneDetail, bots)
  const originName = origin ? describeConversation(origin, bots, t('sidebar.groupFallback')).title : null

  if (finished && stopping) setStopping(false)

  const stopSession = () => {
    setStopping(true)
    stop(workspaceId, session.id).catch(() => {
      setStopping(false)
      showToast('error')
    })
  }

  const meta: { key: string; node: React.ReactNode }[] = []
  if (doing)
    meta.push({
      key: 'doing',
      node: <span className="truncate text-accent">{doing}</span>,
    })
  const helpers = finished ? 0 : (session.subagents?.running ?? 0)
  if (helpers > 0)
    meta.push({
      key: 'helpers',
      node: (
        <span className="flex items-center gap-1 text-accent">
          <Layers size={11} aria-hidden />
          {t('session.helpersRunning', { count: helpers })}
        </span>
      ),
    })
  if (project)
    meta.push({
      key: 'project',
      node: <span className="truncate">{project.name}</span>,
    })
  if (session.branch || session.cwd) {
    const where = session.branch ?? session.cwd ?? ''
    meta.push({
      key: 'where',
      node: (
        <Tooltip content={t('session.copyWhere', { value: where })}>
          <button
            type="button"
            onClick={() => copyWithToast(where)}
            className="no-drag focus-ring flex min-w-0 items-center gap-1 rounded font-mono hover:text-fg"
          >
            {session.branch ? <GitBranch size={11} aria-hidden /> : <FolderGit2 size={11} aria-hidden />}
            <span className="max-w-[260px] truncate">{where}</span>
          </button>
        </Tooltip>
      ),
    })
  }
  if (session.costUsd > 0)
    meta.push({ key: 'cost', node: <span>{formatUsd(session.costUsd, i18n.language)}</span> })
  if (session.changes && session.changes.files > 0)
    meta.push({
      key: 'changes',
      node: <DiffStat added={session.changes.additions} removed={session.changes.deletions} />,
    })

  // A narrow header keeps only where the session works (or what it is doing), so it stays readable.
  const narrowMeta = meta.find((m) => m.key === 'where') ?? meta.find((m) => m.key === 'doing')

  return (
    <header
      className={cn(
        'drag-region @container flex h-16 shrink-0 items-center gap-3 border-b border-border px-4 @max-md:gap-2',
        !debugOpen && 'win:pr-caption-4',
      )}
    >
      <Tooltip
        content={originName ? t('session.backTo', { name: originName }) : t('session.backToChat')}
        side="bottom"
      >
        <button
          type="button"
          onClick={closeWorkSession}
          aria-label={originName ? t('session.backTo', { name: originName }) : t('session.backToChat')}
          className="no-drag focus-ring flex size-8 shrink-0 items-center justify-center rounded-lg text-fg-secondary hover:bg-surface-3"
        >
          <ArrowLeft size={16} />
        </button>
      </Tooltip>
      {bot && (
        <span className="shrink-0 @max-md:hidden">
          <BotAvatar avatar={bot.avatar} state={finished ? 'idle' : session.lane.status} size={34} />
        </span>
      )}
      <div className="flex min-w-0 flex-1 flex-col gap-[3px]">
        <div className="flex min-w-0 items-center gap-2 overflow-hidden">
          <h1 className="min-w-12 truncate text-lg leading-[18px] font-semibold text-fg">{session.title}</h1>
          {/* Below 384px the title keeps the room the status chip would take. */}
          <span className="flex shrink-0 @max-sm:hidden">
            <SessionStatusChip status={session.status} />
          </span>
          {session.model && (
            <span className="flex shrink-0 @max-lg:hidden">
              <SessionModelBadge model={session.model} />
            </span>
          )}
        </div>
        <span className="flex min-w-0 items-center overflow-hidden text-sm leading-4 text-fg-secondary">
          {bot && <span className="shrink-0 font-medium @max-lg:hidden">{bot.name}</span>}
          {meta.map((item, i) => (
            <span
              key={item.key}
              className={cn('flex min-w-0 items-center', item !== narrowMeta && '@max-lg:hidden')}
            >
              {(bot || i > 0) && (
                <span
                  className={cn('shrink-0 px-1.5 text-fg-muted', item === narrowMeta && '@max-lg:hidden')}
                  aria-hidden
                >
                  ·
                </span>
              )}
              {item.node}
            </span>
          ))}
        </span>
      </div>
      {!finished && (
        <Tooltip content={stopping ? null : t('session.stopHint')} side="bottom">
          <button
            type="button"
            onClick={stopSession}
            disabled={stopping}
            className="no-drag focus-ring flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-lg border border-danger-soft px-3 text-sm font-semibold text-danger transition hover:bg-danger/5 disabled:opacity-60 @max-xl:w-8 @max-xl:px-0"
          >
            {stopping ? <Spinner size={13} /> : <Square size={11} fill="currentColor" strokeWidth={0} />}
            <span className="@max-xl:sr-only">{stopping ? t('session.stopping') : t('session.stop')}</span>
          </button>
        </Tooltip>
      )}
      <IconButton label={t('chat.showVm')} active={vmOpen} onClick={() => toggleRightPanel('vm')}>
        <Monitor size={15} />
      </IconButton>
      <IconButton label={t('chat.showDebug')} active={debugOpen} onClick={() => toggleRightPanel('debug')}>
        <Bug size={15} />
      </IconButton>
      <Tooltip content={t('session.menu')} side="bottom">
        <button
          ref={menuButton}
          type="button"
          aria-label={t('session.menu')}
          aria-haspopup="menu"
          onClick={() => {
            const rect = menuButton.current?.getBoundingClientRect()
            if (rect) setMenu({ x: rect.right - 220, y: rect.bottom + 6 })
          }}
          className="no-drag focus-ring flex size-8 shrink-0 items-center justify-center rounded-lg text-fg-secondary hover:bg-surface-3"
        >
          <Ellipsis size={16} />
        </button>
      </Tooltip>
      {menu && (
        <Menu
          x={menu.x}
          y={menu.y}
          width={220}
          label={t('session.menu')}
          onClose={() => setMenu(null)}
          entries={[
            ...(session.cwd
              ? [
                  {
                    key: 'cwd',
                    label: t('session.copyFolder'),
                    icon: <Copy size={14} />,
                    onSelect: () => copyWithToast(session.cwd as string),
                  },
                ]
              : []),
            ...(session.branch
              ? [
                  {
                    key: 'branch',
                    label: t('session.copyBranch'),
                    icon: <GitBranch size={14} />,
                    onSelect: () => copyWithToast(session.branch as string),
                  },
                ]
              : []),
            {
              key: 'delete',
              label: finished ? t('session.delete') : t('session.deleteRunning'),
              icon: <Trash2 size={14} />,
              danger: true,
              disabled: !finished,
              onSelect: () => setConfirmDelete(true),
            },
          ]}
        />
      )}
      {confirmDelete && (
        <ConfirmDialog
          title={t('session.deleteTitle')}
          description={t('session.deleteBody', { title: session.title })}
          width={420}
          confirmLabel={t('session.deleteConfirm')}
          onConfirm={() => remove(workspaceId, session.id).then(closeWorkSession)}
          onClose={() => setConfirmDelete(false)}
        />
      )}
    </header>
  )
}

/** The model a session was opened on when it is not its bot's own. */
function SessionModelBadge({ model }: { model: ModelChoice }) {
  const { t } = useTranslation()
  const known = findCatalogModel(useModelCatalog(), model)
  const name = known ? known.displayName : (model.model ?? '')
  const label = [name, model.effort ? effortLabel(t, model.effort, 'short') : null]
    .filter(Boolean)
    .join(' · ')
  return (
    <Tooltip
      content={
        known
          ? `${t('session.modelBadge')}: ${known.providerName} · ${known.displayName}`
          : t('session.modelBadge')
      }
    >
      <span className="flex shrink-0 items-center gap-1 rounded-md bg-accent-soft px-2 py-[3px] text-xs font-medium text-accent">
        <Cpu size={11} aria-hidden />
        {label}
      </span>
    </Tooltip>
  )
}
