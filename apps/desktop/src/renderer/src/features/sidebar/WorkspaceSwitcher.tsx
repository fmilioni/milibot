import type { VmState, WorkspaceSummary } from '@milibot/shared'
import { AppWindow, Check, ChevronsUpDown, ExternalLink, Plus, Settings2, ShieldCheck } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { useAppStore, useCurrentWorkspace } from '@/features/workspace/store'
import { WorkspaceBadge } from '@/features/workspace/WorkspaceBadge'
import { useDismiss } from '@/hooks/use-dismiss'
import { cn } from '@/lib/cn'
import { hasModKey, shortcutLabel } from '@/lib/platform'
import { Menu } from '@/ui/Menu'
import { META_SEPARATOR, MetaText } from '@/ui/MetaText'
import { SectionTitle } from '@/ui/SectionTitle'
import { Tooltip } from '@/ui/Tooltip'

export function WorkspaceSwitcher() {
  const { t } = useTranslation()
  const current = useCurrentWorkspace()
  const workspaces = useAppStore((s) => s.workspaces)
  const switchWorkspace = useAppStore((s) => s.switchWorkspace)
  const openInNewWindow = useAppStore((s) => s.openWorkspaceInNewWindow)
  const setModal = useAppStore((s) => s.setModal)
  const openSettings = useAppStore((s) => s.openSettings)
  const [open, setOpen] = useState(false)
  const [openIds, setOpenIds] = useState<string[]>([])
  const [windowMenu, setWindowMenu] = useState<{ x: number; y: number } | null>(null)
  const ref = useRef<HTMLDivElement>(null)

  const close = () => {
    setOpen(false)
    setWindowMenu(null)
  }
  useDismiss(ref, open && !windowMenu, close)

  useEffect(() => {
    if (open) void window.milibot.listOpenWorkspaces().then(setOpenIds)
  }, [open])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (hasModKey(event) && event.shiftKey && event.key.toLowerCase() === 'n') {
        event.preventDefault()
        setOpen(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  if (!current) return <div className="h-8" />
  const others = workspaces.filter((w) => w.id !== current.id)

  return (
    <div ref={ref} data-menu className="no-drag relative min-w-0">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t('workspace.switcherLabel')}
        className={cn(
          'focus-ring flex h-8 min-w-0 items-center gap-2 rounded-lg py-1 pr-2 pl-1 hover:bg-surface-3',
          open && 'bg-surface-3',
        )}
      >
        <WorkspaceBadge name={current.name} color={current.color} icon={current.icon} />
        <span className="truncate text-lg font-bold text-fg">{current.name}</span>
        <ChevronsUpDown size={13} className="shrink-0 text-fg-muted" />
      </button>

      {open && (
        <div
          role="menu"
          aria-label={t('workspace.menuTitle')}
          className="absolute top-full left-0 z-panel mt-1.5 flex w-80 flex-col gap-0.5 rounded-xl border border-border bg-surface-2 p-1.5 shadow-[0_12px_32px_rgba(0,0,0,0.16)]"
        >
          <SectionTitle as="div" className="px-2 pt-1.5 pb-1">
            {t('workspace.menuTitle')}
          </SectionTitle>
          {workspaces.map((workspace) => (
            <WorkspaceRow
              key={workspace.id}
              workspace={workspace}
              current={workspace.id === current.id}
              openElsewhere={workspace.id !== current.id && openIds.includes(workspace.id)}
              onSelect={() => {
                close()
                void switchWorkspace(workspace.id)
              }}
              onOpenWindow={() => {
                close()
                openInNewWindow(workspace.id)
              }}
            />
          ))}
          <div className="my-px h-px bg-border" />
          <MenuRow
            icon={<AppWindow size={14} />}
            label={t('workspace.openInNewWindow')}
            shortcut={shortcutLabel('N', true)}
            disabled={others.length === 0}
            onClick={(e) => {
              const rect = e.currentTarget.getBoundingClientRect()
              setWindowMenu({ x: rect.right + 4, y: rect.top - 5 })
            }}
          />
          <MenuRow
            icon={<Plus size={14} />}
            label={t('workspace.new')}
            onClick={() => {
              close()
              setModal({ type: 'newWorkspace' })
            }}
          />
          <MenuRow
            icon={<Settings2 size={14} />}
            label={t('workspace.manage')}
            onClick={() => {
              close()
              openSettings('workspaces')
            }}
          />
          <div className="mt-0.5 flex items-start gap-2 rounded-lg bg-accent-soft px-[9px] py-2 text-xs leading-[13px] text-accent">
            <ShieldCheck size={13} className="mt-px shrink-0" />
            {t('workspace.isolationNote')}
          </div>
        </div>
      )}
      {windowMenu && (
        <Menu
          x={windowMenu.x}
          y={windowMenu.y}
          width={200}
          onClose={close}
          label={t('workspace.openInNewWindow')}
          entries={others.map((w) => ({
            key: w.id,
            label: w.name,
            icon: <WorkspaceBadge name={w.name} color={w.color} icon={w.icon} size={14} />,
            onSelect: () => openInNewWindow(w.id),
          }))}
        />
      )}
    </div>
  )
}

function WorkspaceRow({
  workspace,
  current,
  openElsewhere,
  onSelect,
  onOpenWindow,
}: {
  workspace: WorkspaceSummary
  current: boolean
  openElsewhere: boolean
  onSelect: () => void
  onOpenWindow: () => void
}) {
  const { t } = useTranslation()
  const vm = useAppStore((s) => s.vm)
  const busyBots = useAppStore((s) => Object.values(s.bots).filter((b) => b.status !== 'idle').length)

  let statusText: string
  let dot: string
  if (workspace.setup !== 'done') {
    statusText = t('setup.pending')
    dot = 'bg-warning'
  } else if (current) {
    const state = vm?.state ?? 'not_created'
    const vmText = t(`workspace.vmState.${state}`)
    statusText =
      busyBots > 0 ? `${vmText}${META_SEPARATOR}${t('workspace.botsWorking', { count: busyBots })}` : vmText
    dot = vmDot(state)
  } else if (workspace.runtimeStatus === 'crashed') {
    statusText = t('workspace.runtimeCrashed')
    dot = 'bg-danger'
  } else {
    statusText = t(`workspace.vmState.${workspace.vmState}`)
    dot = vmDot(workspace.vmState)
  }

  return (
    <div
      className={cn(
        'group flex h-[47px] items-center gap-2.5 rounded-lg px-2',
        current ? 'bg-surface-3' : 'hover:bg-surface-3/70',
      )}
    >
      <button
        type="button"
        role="menuitemradio"
        aria-checked={current}
        onClick={onSelect}
        className="focus-ring flex min-w-0 flex-1 items-center gap-2.5 rounded-md text-left"
      >
        <WorkspaceBadge name={workspace.name} color={workspace.color} icon={workspace.icon} size={30} />
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="truncate text-base font-semibold text-fg">{workspace.name}</span>
          <span className="flex items-center gap-[5px] text-xs text-fg-muted">
            <span className={`size-1.5 shrink-0 rounded-full ${dot}`} />
            <span className="truncate">
              <MetaText text={statusText} />
            </span>
          </span>
        </span>
      </button>
      {current && <Check size={14} className="shrink-0 text-accent" aria-hidden />}
      {openElsewhere && (
        <span className="flex shrink-0 items-center gap-1 rounded-[5px] bg-surface-3 px-1.5 py-0.5 text-2xs text-fg-secondary">
          <AppWindow size={11} />
          {t('workspace.openBadge')}
        </span>
      )}
      {!current && !openElsewhere && (
        <Tooltip content={t('workspace.openInNewWindow')}>
          <button
            type="button"
            onClick={onOpenWindow}
            aria-label={t('workspace.openNamedInNewWindow', { name: workspace.name })}
            className="focus-ring shrink-0 rounded p-0.5 text-fg-muted opacity-0 group-hover:opacity-100 hover:text-fg focus-visible:opacity-100"
          >
            <ExternalLink size={13} />
          </button>
        </Tooltip>
      )}
    </div>
  )
}

function vmDot(state: VmState): string {
  return state === 'running' ? 'bg-success' : state === 'error' ? 'bg-danger' : 'bg-fg-muted'
}

function MenuRow({
  icon,
  label,
  shortcut,
  disabled,
  onClick,
}: {
  icon: React.ReactNode
  label: string
  shortcut?: string
  disabled?: boolean
  onClick?: (event: React.MouseEvent<HTMLButtonElement>) => void
}) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      onClick={onClick}
      className="focus-ring flex h-[30px] w-full items-center gap-[9px] rounded-md px-[9px] text-left text-base text-fg hover:bg-surface-3 disabled:opacity-50 disabled:hover:bg-transparent"
    >
      <span className="text-fg-secondary">{icon}</span>
      <span className="flex-1 truncate">{label}</span>
      {shortcut && <span className="text-xs text-fg-muted">{shortcut}</span>}
    </button>
  )
}
