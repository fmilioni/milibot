import type { ConversationSummary } from '@milibot/shared'
import { FolderOpen } from 'lucide-react'
import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'

import { useProjectStore } from '@/features/projects/store'
import { useAppStore } from '@/features/workspace/store'
import { cn } from '@/lib/cn'
import type { SelectOption } from '@/lib/select'
import { Select } from '@/ui/Select'

const NONE = '__none__'

/** Current project of the conversation; choosing another one moves the conversation to it. */
export function ProjectChip({ conversation }: { conversation: ConversationSummary }) {
  const { t } = useTranslation()
  const workspaceId = useAppStore((s) => s.workspaceId)
  const projects = useProjectStore((s) => s.projects)
  const loadedFor = useProjectStore((s) => s.workspaceId)
  const load = useProjectStore((s) => s.load)
  const setProject = useProjectStore((s) => s.setConversationProject)

  useEffect(() => {
    if (workspaceId && loadedFor !== workspaceId) void load(workspaceId).catch(() => undefined)
  }, [workspaceId, loadedFor, load])

  const current = projects.find((p) => p.id === conversation.projectId) ?? null
  const active = projects.filter((p) => !p.archivedAt || p.id === current?.id)
  if (!workspaceId || (!active.length && !current)) return null

  const options: SelectOption<string>[] = [
    { value: NONE, label: t('projects.none'), description: t('projects.noneHint') },
    ...active.map((p) => ({
      value: p.id,
      label: p.name,
      ...(p.description ? { description: p.description } : {}),
    })),
  ]

  return (
    <Select
      value={current?.id ?? NONE}
      options={options}
      label={t('projects.current')}
      size="sm"
      menuWidth={280}
      menuAlign="end"
      className="no-drag max-w-[200px]"
      renderValue={() => (
        <span className="flex min-w-0 items-center gap-1.5">
          <FolderOpen size={13} className={current ? 'shrink-0 text-accent' : 'shrink-0 text-fg-muted'} />
          <span className={cn('truncate', current ? 'text-fg' : 'text-fg-muted')}>
            {current?.name ?? t('projects.none')}
          </span>
        </span>
      )}
      onChange={(value) =>
        void setProject(workspaceId, conversation.id, value === NONE ? null : value).catch(() => undefined)
      }
    />
  )
}
