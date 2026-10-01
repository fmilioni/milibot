import { type WorkSession, WorkSessionStatus } from '@milibot/shared'
import { Rocket } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { PlanProgress } from '@/features/plans/PlanParts'
import { useProjectStore } from '@/features/projects/store'
import type { SessionFilters } from '@/features/sessions/lib/session-view'
import { SettingsFilterBar } from '@/features/settings/SettingsFilterBar'
import { SettingsPage } from '@/features/settings/SettingsLayout'
import { SettingsList, SettingsListRow } from '@/features/settings/SettingsList'
import { useAppStore } from '@/features/workspace/store'
import { useWorkspaceId } from '@/features/workspace/use-workspace-id'
import { formatListTime } from '@/lib/format'
import { DiffStat } from '@/ui/diff/DiffStat'

import { SessionStatusChip } from './SessionParts'
import { useSessionStore } from './store'

/** "Work sessions": every session of the workspace, filterable, each opening its screen. */
export function SessionsSettings() {
  const { t, i18n } = useTranslation()
  const workspaceId = useWorkspaceId()
  const bots = useAppStore((s) => s.bots)
  const showToast = useAppStore((s) => s.showToast)
  const openWorkSession = useAppStore((s) => s.openWorkSession)
  const ids = useSessionStore((s) => s.list)
  const sessions = useSessionStore((s) => s.sessions)
  const loading = useSessionStore((s) => s.listLoading)
  const loadList = useSessionStore((s) => s.loadList)
  const projects = useProjectStore((s) => s.projects)
  const loadProjects = useProjectStore((s) => s.load)
  const [filters, setFilters] = useState<SessionFilters>({})

  useEffect(() => {
    void loadProjects(workspaceId).catch(() => undefined)
  }, [loadProjects, workspaceId])

  useEffect(() => {
    void loadList(workspaceId, filters).catch(() => showToast('error'))
  }, [loadList, workspaceId, filters, showToast])

  const list = ids.flatMap((id) => sessions[id] ?? [])
  const filtered = Boolean(filters.status || filters.projectId || filters.botId)

  const row = (session: WorkSession) => {
    const project = session.projectId ? projects.find((p) => p.id === session.projectId) : null
    return (
      <SettingsListRow
        key={session.id}
        icon={<Rocket size={16} />}
        onClick={() => void openWorkSession(session.id).catch(() => showToast('error'))}
      >
        <div className="flex items-center gap-2">
          <span className="truncate text-base font-semibold text-fg">{session.title}</span>
          <span className="flex-1" />
          {session.changes && session.changes.files > 0 && (
            <DiffStat added={session.changes.additions} removed={session.changes.deletions} />
          )}
          <SessionStatusChip status={session.status} />
        </div>
        <span className="line-clamp-2 text-sm leading-[17px] text-fg-secondary">
          {session.resultSummary ?? session.goal}
        </span>
        <span className="flex flex-wrap gap-x-3 text-xs text-fg-muted">
          <span>{bots[session.botId]?.name ?? '…'}</span>
          <span>{project?.name ?? t('projects.general')}</span>
          {session.branch && <span className="font-mono">{session.branch}</span>}
          <span>
            {t('session.settings.updated', { when: formatListTime(session.updatedAt, i18n.language, t) })}
          </span>
        </span>
        {session.steps.total > 0 && (
          <div className="max-w-[320px] pt-0.5">
            <PlanProgress {...session.steps} />
          </div>
        )}
      </SettingsListRow>
    )
  }

  return (
    <SettingsPage title={t('settings.sections.sessions')} subtitle={t('session.settings.subtitle')}>
      <SettingsFilterBar
        statuses={WorkSessionStatus.options.map((s) => ({ value: s, label: t(`chat.session.status.${s}`) }))}
        filters={filters}
        onChange={(patch) => setFilters((f) => ({ ...f, ...patch }))}
      />
      <SettingsList
        items={list}
        loading={loading}
        empty={filtered ? t('session.settings.emptyFiltered') : t('session.settings.empty')}
      >
        {row}
      </SettingsList>
    </SettingsPage>
  )
}
