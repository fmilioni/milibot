import { useTranslation } from 'react-i18next'

import { useProjectStore } from '@/features/projects/store'
import { useAppStore } from '@/features/workspace/store'
import type { SelectOption } from '@/lib/select'
import { botOptions, projectOptions } from '@/lib/select-options'
import { Select } from '@/ui/Select'
import { SearchInput } from '@/ui/TextInput'

export interface ListFilters<S extends string> {
  status?: S
  /** A project id, or `general`. */
  projectId?: string
  botId?: string
}

/** Search field (optional) and status / project / bot selects above a settings list. */
export function SettingsFilterBar<S extends string>({
  statuses,
  filters,
  onChange,
  search,
}: {
  /** Every status, "All statuses" comes first on its own. */
  statuses: SelectOption<S>[]
  filters: ListFilters<S>
  onChange: (patch: ListFilters<S>) => void
  search?: { value: string; onChange: (value: string) => void; placeholder: string }
}) {
  const { t } = useTranslation()
  const bots = useAppStore((s) => s.bots)
  const projects = useProjectStore((s) => s.projects)
  const all = (label: string): SelectOption<string> => ({ value: '', label })
  return (
    <div className="flex flex-wrap items-center gap-2">
      {search && (
        <SearchInput
          value={search.value}
          onChange={search.onChange}
          placeholder={search.placeholder}
          className="w-[260px]"
        />
      )}
      <div className="w-[170px]">
        <Select
          size="sm"
          tone="surface-2"
          label={t('common.filters.allStatuses')}
          value={filters.status ?? ''}
          options={[all(t('common.filters.allStatuses')), ...statuses]}
          onChange={(status) => onChange({ status: (status || undefined) as S | undefined })}
        />
      </div>
      {projects.length > 0 && (
        <div className="w-[170px]">
          <Select
            size="sm"
            tone="surface-2"
            label={t('common.filters.allProjects')}
            value={filters.projectId ?? ''}
            options={projectOptions(projects, t, { all: true, includeArchived: true })}
            onChange={(projectId) => onChange({ projectId: projectId || undefined })}
          />
        </div>
      )}
      <div className="w-[150px]">
        <Select
          size="sm"
          tone="surface-2"
          label={t('common.filters.allBots')}
          value={filters.botId ?? ''}
          options={[all(t('common.filters.allBots')), ...botOptions(bots)]}
          onChange={(botId) => onChange({ botId: botId || undefined })}
        />
      </div>
    </div>
  )
}
