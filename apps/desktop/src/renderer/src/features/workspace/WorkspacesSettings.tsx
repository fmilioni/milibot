import type { WorkspaceOverview, WorkspaceSummary } from '@milibot/shared'
import { AppWindow, ArrowRightLeft, HardDrive, Pencil, Play, Plus, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { queryKeys } from '@/api/queries'
import { useApiQuery } from '@/api/use-api-query'
import { listWorkspaceOverviews } from '@/features/settings/api'
import { DeleteWorkspaceDialog } from '@/features/settings/GeneralSettings'
import { Notice, SettingsPage } from '@/features/settings/SettingsLayout'
import { useSettingsStore } from '@/features/settings/store'
import { useNow } from '@/hooks/use-now'
import { formatBytes } from '@/lib/format'
import { Button } from '@/ui/Button'
import type { MenuEntry } from '@/ui/Menu'
import { MetaText } from '@/ui/MetaText'
import { MoreMenu } from '@/ui/MoreMenu'
import { StatusDot } from '@/ui/Tag'
import { TextInput } from '@/ui/TextInput'

import { useAppStore } from './store'
import { WorkspaceBadge } from './WorkspaceBadge'

const DAY = 86_400_000

function WorkspaceRow({
  workspace,
  overview,
  current,
  openElsewhere,
}: {
  workspace: WorkspaceSummary
  overview: WorkspaceOverview | undefined
  current: boolean
  openElsewhere: boolean
}) {
  const { t, i18n } = useTranslation()
  const switchWorkspace = useAppStore((s) => s.switchWorkspace)
  const openInNewWindow = useAppStore((s) => s.openWorkspaceInNewWindow)
  const updateWorkspace = useAppStore((s) => s.updateWorkspace)
  const [renaming, setRenaming] = useState(false)
  const [name, setName] = useState(workspace.name)
  const [deleting, setDeleting] = useState(false)
  const locale = i18n.language
  const now = useNow(60_000)

  const state = overview?.vmState ?? 'not_created'
  const pendingSetup = workspace.setup !== 'done'
  const status = pendingSetup
    ? [t('setup.pending')]
    : [
        t(`settings.workspaces.vm.${state}`),
        state === 'running' && overview?.workingBots
          ? t('settings.workspaces.working', { count: overview.workingBots })
          : null,
      ].filter(Boolean)
  const specs = [
    overview?.cpus && overview.memGb
      ? t('settings.workspaces.specs', { cpus: overview.cpus, mem: overview.memGb })
      : null,
    overview?.diskUsedBytes != null && overview.dataGb
      ? t('settings.workspaces.disk', {
          used: formatBytes(overview.diskUsedBytes, locale),
          total: overview.dataGb,
        })
      : null,
    overview ? t('settings.workspaces.bots', { count: overview.bots }) : null,
    overview?.groups ? t('settings.workspaces.groups', { count: overview.groups }) : null,
    current
      ? t('settings.workspaces.thisWindow')
      : openElsewhere
        ? t('settings.workspaces.otherWindow')
        : workspace.lastOpenedAt
          ? t('settings.workspaces.lastOpened', {
              when: new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }).format(
                -Math.max(0, Math.round((now - workspace.lastOpenedAt) / DAY)),
                'day',
              ),
            })
          : t('settings.workspaces.neverOpened'),
  ].filter((part): part is string => Boolean(part))

  const entries: MenuEntry[] = [
    ...(!current
      ? [
          {
            key: 'here',
            label: t('settings.workspaces.openHere'),
            icon: <ArrowRightLeft size={14} />,
            onSelect: () => void switchWorkspace(workspace.id),
          },
        ]
      : []),
    {
      key: 'rename',
      label: t('settings.workspaces.rename'),
      icon: <Pencil size={14} />,
      onSelect: () => setRenaming(true),
    },
    { type: 'separator', key: 'sep' },
    {
      key: 'delete',
      label: t('settings.workspaces.delete'),
      icon: <Trash2 size={14} />,
      danger: true,
      onSelect: () => setDeleting(true),
    },
  ]

  const saveName = () => {
    setRenaming(false)
    const trimmed = name.trim()
    if (trimmed && trimmed !== workspace.name) void updateWorkspace(workspace.id, { name: trimmed })
    else setName(workspace.name)
  }

  return (
    <li className="flex items-center gap-3.5 rounded-xl border border-border bg-surface-2 px-3.5 py-3">
      <WorkspaceBadge name={workspace.name} color={workspace.color} icon={workspace.icon} size={40} />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex min-w-0 items-center gap-2">
          {renaming ? (
            <TextInput
              autoFocus
              aria-label={t('settings.workspaces.rename')}
              value={name}
              className="h-[28px] w-[240px]"
              onChange={(e) => setName(e.target.value)}
              onBlur={saveName}
              onKeyDown={(e) => {
                if (e.key === 'Enter') e.currentTarget.blur()
                if (e.key === 'Escape') {
                  e.preventDefault()
                  setName(workspace.name)
                  setRenaming(false)
                }
              }}
            />
          ) : (
            <span className="truncate text-md font-semibold text-fg">{workspace.name}</span>
          )}
          <span className="flex shrink-0 items-center gap-1.5 text-xs text-fg-muted">
            <StatusDot tone={pendingSetup ? 'warning' : state === 'running' ? 'success' : 'muted'} />
            {status.join(' · ')}
          </span>
        </div>
        <span className="truncate text-sm text-fg-secondary">
          <MetaText parts={specs} />
        </span>
      </div>
      {current ? null : openElsewhere ? (
        <Button size="sm" onClick={() => openInNewWindow(workspace.id)}>
          <AppWindow size={12} />
          {t('settings.workspaces.goToWindow')}
        </Button>
      ) : (
        <Button size="sm" variant="primary" onClick={() => openInNewWindow(workspace.id)}>
          <Play size={12} />
          {t('settings.workspaces.open')}
        </Button>
      )}
      <MoreMenu
        label={t('settings.workspaces.more', { name: workspace.name })}
        entries={entries}
        width={210}
        menuLabel={workspace.name}
      />
      {deleting && <DeleteWorkspaceDialog workspace={workspace} onClose={() => setDeleting(false)} />}
    </li>
  )
}

export function WorkspacesSettings() {
  const { t, i18n } = useTranslation()
  const workspaces = useAppStore((s) => s.workspaces)
  const currentId = useAppStore((s) => s.workspaceId)
  const setModal = useAppStore((s) => s.setModal)
  const host = useSettingsStore((s) => s.host)
  const loadHost = useSettingsStore((s) => s.loadHost)
  // Workspace events invalidate both (`api/cache-updates.ts`).
  const overviews = useApiQuery(queryKeys.workspaceOverviews(), listWorkspaceOverviews).data ?? []
  const openIds =
    useApiQuery(queryKeys.openWorkspaces(), () => window.milibot.listOpenWorkspaces()).data ?? []

  useEffect(() => {
    void loadHost().catch(() => undefined)
  }, [loadHost])

  const sorted = [...workspaces].sort((a, b) =>
    a.id === currentId ? -1 : b.id === currentId ? 1 : (b.lastOpenedAt ?? 0) - (a.lastOpenedAt ?? 0),
  )

  return (
    <SettingsPage title={t('settings.sections.workspaces')} subtitle={t('settings.workspaces.subtitle')}>
      <ul className="flex flex-col gap-2.5">
        {sorted.map((workspace) => (
          <WorkspaceRow
            key={workspace.id}
            workspace={workspace}
            overview={overviews.find((o) => o.id === workspace.id)}
            current={workspace.id === currentId}
            openElsewhere={workspace.id !== currentId && openIds.includes(workspace.id)}
          />
        ))}
      </ul>
      <div>
        <Button variant="primary" onClick={() => setModal({ type: 'newWorkspace' })}>
          <Plus size={13} />
          {t('settings.workspaces.new')}
        </Button>
      </div>
      {host?.goldenImage && (
        <Notice icon={<HardDrive size={14} />}>
          {t('settings.workspaces.golden', { size: formatBytes(host.goldenImage.bytes, i18n.language) })}
        </Notice>
      )}
    </SettingsPage>
  )
}
