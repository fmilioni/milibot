import { type Plan, planProgress, PlanStatus } from '@milibot/shared'
import { ClipboardList } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import type { PlanFilters } from '@/features/plans/lib/plans'
import { useProjectStore } from '@/features/projects/store'
import { SettingsFilterBar } from '@/features/settings/SettingsFilterBar'
import { SettingsPage } from '@/features/settings/SettingsLayout'
import { SettingsList, SettingsListRow } from '@/features/settings/SettingsList'
import { useAppStore } from '@/features/workspace/store'
import { useWorkspaceId } from '@/features/workspace/use-workspace-id'
import { formatListTime } from '@/lib/format'

import { PlanDialog } from './PlanDialog'
import { PlanProgress, PlanStatusChip } from './PlanParts'
import { usePlanStore } from './store'

/** "Plans": every plan of the workspace, filterable, each opening its full view. */
export function PlansSettings() {
  const { t, i18n } = useTranslation()
  const workspaceId = useWorkspaceId()
  const bots = useAppStore((s) => s.bots)
  const showToast = useAppStore((s) => s.showToast)
  const plans = usePlanStore((s) => s.plans)
  const loading = usePlanStore((s) => s.loading)
  const load = usePlanStore((s) => s.load)
  const projects = useProjectStore((s) => s.projects)
  const loadProjects = useProjectStore((s) => s.load)
  const [filters, setFilters] = useState<PlanFilters>({})
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState<string | null>(null)

  useEffect(() => {
    void loadProjects(workspaceId).catch(() => undefined)
  }, [loadProjects, workspaceId])

  useEffect(() => {
    const timer = setTimeout(
      () =>
        void load(workspaceId, { ...filters, q: query.trim() || undefined }).catch(() => showToast('error')),
      query ? 250 : 0,
    )
    return () => clearTimeout(timer)
  }, [load, workspaceId, filters, query, showToast])

  const filtered = Boolean(query.trim() || filters.status || filters.projectId || filters.botId)

  const row = (plan: Plan) => {
    const project = plan.projectId ? projects.find((p) => p.id === plan.projectId) : null
    const progress = planProgress(plan.steps)
    const started = plan.status === 'approved' || plan.status === 'executing' || plan.status === 'done'
    return (
      <SettingsListRow key={plan.id} icon={<ClipboardList size={16} />} onClick={() => setOpen(plan.id)}>
        <div className="flex items-center gap-2">
          <span className="truncate text-base font-semibold text-fg">{plan.title}</span>
          <span className="flex-1" />
          <PlanStatusChip status={plan.status} />
        </div>
        <span className="line-clamp-2 text-sm leading-[17px] text-fg-secondary">{plan.summary}</span>
        <span className="flex flex-wrap gap-x-3 text-xs text-fg-muted">
          <span>{bots[plan.botId]?.name ?? '…'}</span>
          <span>{project?.name ?? t('plans.general')}</span>
          <span>
            {t('plans.settings.updated', {
              when: formatListTime(plan.updatedAt, i18n.language, t),
            })}
          </span>
        </span>
        {started && progress.total > 0 && (
          <div className="max-w-[320px] pt-0.5">
            <PlanProgress {...progress} />
          </div>
        )}
      </SettingsListRow>
    )
  }

  return (
    <SettingsPage title={t('settings.sections.plans')} subtitle={t('plans.settings.subtitle')}>
      <SettingsFilterBar
        statuses={PlanStatus.options.map((s) => ({ value: s, label: t(`plans.status.${s}`) }))}
        filters={filters}
        onChange={(patch) => setFilters((f) => ({ ...f, ...patch }))}
        search={{ value: query, onChange: setQuery, placeholder: t('plans.settings.search') }}
      />
      <SettingsList
        items={plans}
        loading={loading}
        empty={filtered ? t('plans.settings.emptyFiltered') : t('plans.settings.empty')}
      >
        {row}
      </SettingsList>
      {open && <PlanDialog planId={open} onClose={() => setOpen(null)} />}
    </SettingsPage>
  )
}
