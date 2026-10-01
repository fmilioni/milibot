import type { PromptUpdateMode } from '@milibot/shared'
import { Info, Plus } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { queryKeys } from '@/api/queries'
import { useApiQuery } from '@/api/use-api-query'
import { useProjectStore } from '@/features/projects/store'
import { Notice, SettingsCard, SettingsPage, SettingsRow } from '@/features/settings/SettingsLayout'
import { useWorkspacePreferences } from '@/features/settings/store'
import { useAppStore } from '@/features/workspace/store'
import { useApiMutation } from '@/features/workspace/use-api-mutation'
import { GENERAL_PROJECT, projectOptions as buildProjectOptions } from '@/lib/select-options'
import { Button } from '@/ui/Button'
import { Select } from '@/ui/Select'
import { Spinner } from '@/ui/Spinner'

import {
  createWorkspaceMemory,
  deleteWorkspaceMemory,
  listWorkspaceMemories,
  updateWorkspaceMemory,
} from './api'
import { NoteEditor } from './NoteEditor'
import { NoteItem } from './NoteItem'

/** "Memory" (workspace): notes every bot sees and how bots may change their own prompts. */
export function MemorySettings() {
  const { t } = useTranslation()
  const workspaceId = useAppStore((s) => s.workspaceId) ?? ''
  const { prefs, loaded, set } = useWorkspacePreferences(workspaceId)
  const query = useApiQuery(queryKeys.workspaceMemories(workspaceId), () =>
    listWorkspaceMemories(workspaceId),
  )
  const notes = query.data ?? (query.error ? [] : null)
  const [adding, setAdding] = useState(false)
  const projects = useProjectStore((s) => s.projects)
  const loadProjects = useProjectStore((s) => s.load)
  /** '' (all), `general` (no project) or a project id. */
  const [filter, setFilter] = useState('')

  useEffect(() => {
    void loadProjects(workspaceId).catch(() => undefined)
  }, [loadProjects, workspaceId])

  const change = useApiMutation((action: () => Promise<unknown>) => action(), {
    invalidates: [queryKeys.workspaceMemories(workspaceId)],
  })
  const run = async (action: () => Promise<unknown>) => {
    await change.run(action)
  }

  const projectOptions = buildProjectOptions(projects, t)
  const filterOptions = buildProjectOptions(projects, t, { all: true })
  const visible = (notes ?? []).filter((n) =>
    filter === '' ? true : filter === GENERAL_PROJECT ? !n.projectId : n.projectId === filter,
  )
  const newNoteProject = filter === '' || filter === GENERAL_PROJECT ? null : filter

  const modeOptions: Array<{ value: PromptUpdateMode; label: string; description: string }> = [
    {
      value: 'auto',
      label: t('memory.settings.modes.auto'),
      description: t('memory.settings.modes.autoHint'),
    },
    {
      value: 'approval',
      label: t('memory.settings.modes.approval'),
      description: t('memory.settings.modes.approvalHint'),
    },
  ]

  return (
    <SettingsPage
      title={t('settings.sections.memory')}
      subtitle={t('memory.settings.subtitle')}
      width="narrow"
      actions={
        !adding && (
          <Button size="sm" variant="primary" onClick={() => setAdding(true)}>
            <Plus size={13} />
            {t('memory.settings.add')}
          </Button>
        )
      }
    >
      <SettingsCard title={t('memory.settings.notesTitle')}>
        <div className="flex flex-col gap-2.5 px-4 pt-1 pb-4">
          <span className="text-sm text-fg-muted">{t('memory.settings.notesHint')}</span>
          {projects.length > 0 && (
            <div className="w-[220px]">
              <Select
                label={t('projects.filterLabel')}
                value={filter}
                options={filterOptions}
                size="sm"
                tone="surface-2"
                onChange={setFilter}
              />
            </div>
          )}
          {adding && (
            <NoteEditor
              initial=""
              placeholder={t('memory.settings.placeholder')}
              onCancel={() => setAdding(false)}
              onSave={(content) =>
                run(() =>
                  createWorkspaceMemory(workspaceId, { content, pinned: true, projectId: newNoteProject }),
                ).then(() => setAdding(false))
              }
            />
          )}
          {notes === null ? (
            <Spinner className="text-fg-muted" />
          ) : visible.length === 0 ? (
            !adding && (
              <div className="rounded-lg border border-dashed border-border px-3 py-3 text-sm text-fg-muted">
                {t('memory.settings.empty')}
              </div>
            )
          ) : (
            <ul className="flex flex-col overflow-hidden rounded-lg border border-border">
              {visible.map((note) => (
                <NoteItem
                  key={note.id}
                  note={note}
                  extra={
                    projects.length > 0 && (
                      <div className="w-[150px] shrink-0">
                        <Select
                          label={t('projects.noteProject')}
                          value={note.projectId ?? GENERAL_PROJECT}
                          options={
                            note.projectId && !projectOptions.some((o) => o.value === note.projectId)
                              ? [
                                  ...projectOptions,
                                  {
                                    value: note.projectId,
                                    label: projects.find((p) => p.id === note.projectId)?.name ?? '…',
                                  },
                                ]
                              : projectOptions
                          }
                          size="sm"
                          tone="surface-2"
                          onChange={(value) =>
                            run(() =>
                              updateWorkspaceMemory(workspaceId, note.id, {
                                projectId: value === GENERAL_PROJECT ? null : value,
                              }),
                            )
                          }
                        />
                      </div>
                    )
                  }
                  onSave={(content) => run(() => updateWorkspaceMemory(workspaceId, note.id, { content }))}
                  onDelete={() => run(() => deleteWorkspaceMemory(workspaceId, note.id))}
                />
              ))}
            </ul>
          )}
        </div>
      </SettingsCard>

      <SettingsCard title={t('memory.settings.promptsTitle')}>
        <SettingsRow label={t('memory.settings.modeLabel')} hint={t('memory.settings.modeHint')}>
          <div className="w-[230px]">
            <Select
              label={t('memory.settings.modeLabel')}
              value={prefs.promptUpdates}
              options={modeOptions}
              size="sm"
              tone="surface-2"
              disabled={!loaded}
              onChange={(promptUpdates) => void set({ promptUpdates })}
            />
          </div>
        </SettingsRow>
      </SettingsCard>
      <Notice icon={<Info size={14} />}>{t('memory.settings.howItWorks')}</Notice>
    </SettingsPage>
  )
}
