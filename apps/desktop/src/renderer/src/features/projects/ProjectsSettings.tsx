import type { Project } from '@milibot/shared'
import { Archive, ArchiveRestore, FolderKanban, GitBranch, Info, Pencil, Plus, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Notice, SettingsCard, SettingsPage } from '@/features/settings/SettingsLayout'
import { toastOnError, useAppStore } from '@/features/workspace/store'
import { useWorkspaceId } from '@/features/workspace/use-workspace-id'
import { isApiError } from '@/lib/errors'
import { Button } from '@/ui/Button'
import { ConfirmDialog } from '@/ui/Confirm'
import { Modal } from '@/ui/Modal'
import { Spinner } from '@/ui/Spinner'
import { FieldLabel, TextArea, TextInput } from '@/ui/TextInput'
import { Tooltip } from '@/ui/Tooltip'

import { useProjectStore } from './store'

interface Draft {
  name: string
  description: string
  repos: string
  vmPath: string
}

const EMPTY_DRAFT: Draft = { name: '', description: '', repos: '', vmPath: '' }

function toDraft(project: Project): Draft {
  return {
    name: project.name,
    description: project.description,
    repos: project.repos.join('\n'),
    vmPath: project.vmPath ?? '',
  }
}

function fromDraft(draft: Draft) {
  return {
    name: draft.name.trim(),
    description: draft.description.trim(),
    repos: draft.repos
      .split(/[\n,]/)
      .map((r) => r.trim())
      .filter(Boolean),
    vmPath: draft.vmPath.trim() || null,
  }
}

/** "Projects": lines of work inside the workspace, each with its own documents and notes. */
export function ProjectsSettings() {
  const { t } = useTranslation()
  const workspaceId = useWorkspaceId()
  const showToast = useAppStore((s) => s.showToast)
  const projects = useProjectStore((s) => s.projects)
  const loading = useProjectStore((s) => s.loading)
  const load = useProjectStore((s) => s.load)
  const update = useProjectStore((s) => s.update)
  const [editing, setEditing] = useState<Project | 'new' | null>(null)
  const [deleting, setDeleting] = useState<Project | null>(null)

  useEffect(() => {
    void load(workspaceId).catch(() => showToast('error'))
  }, [load, workspaceId, showToast])

  const active = projects.filter((p) => !p.archivedAt)
  const archived = projects.filter((p) => p.archivedAt)

  const row = (project: Project) => (
    <li
      key={project.id}
      className="group flex items-start gap-3 border-b border-border px-4 py-3 last:border-0"
    >
      <FolderKanban size={16} className="mt-0.5 shrink-0 text-fg-muted" aria-hidden />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="truncate text-base font-semibold text-fg">{project.name}</span>
        {project.description && (
          <span className="text-sm leading-[17px] whitespace-pre-wrap text-fg-secondary">
            {project.description}
          </span>
        )}
        {(project.repos.length > 0 || project.vmPath) && (
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-fg-muted">
            {project.repos.length > 0 && (
              <span className="flex min-w-0 items-center gap-1">
                <GitBranch size={11} aria-hidden />
                <span className="truncate font-mono">{project.repos.join(', ')}</span>
              </span>
            )}
            {project.vmPath && <span className="truncate font-mono">{project.vmPath}</span>}
          </span>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-0.5">
        <Tooltip content={t('projects.edit')}>
          <button
            type="button"
            aria-label={t('projects.edit')}
            onClick={() => setEditing(project)}
            className="focus-ring rounded p-1.5 text-fg-muted hover:bg-surface-3 hover:text-fg"
          >
            <Pencil size={13} />
          </button>
        </Tooltip>
        <Tooltip content={project.archivedAt ? t('projects.unarchive') : t('projects.archive')}>
          <button
            type="button"
            aria-label={project.archivedAt ? t('projects.unarchive') : t('projects.archive')}
            onClick={() =>
              void toastOnError(update(workspaceId, project.id, { archived: !project.archivedAt }))
            }
            className="focus-ring rounded p-1.5 text-fg-muted hover:bg-surface-3 hover:text-fg"
          >
            {project.archivedAt ? <ArchiveRestore size={13} /> : <Archive size={13} />}
          </button>
        </Tooltip>
        <Tooltip content={t('projects.delete')}>
          <button
            type="button"
            aria-label={t('projects.delete')}
            onClick={() => setDeleting(project)}
            className="focus-ring rounded p-1.5 text-fg-muted hover:bg-surface-3 hover:text-danger"
          >
            <Trash2 size={13} />
          </button>
        </Tooltip>
      </div>
    </li>
  )

  return (
    <SettingsPage
      title={t('settings.sections.projects')}
      subtitle={t('projects.subtitle')}
      width="narrow"
      actions={
        <Button size="sm" variant="primary" onClick={() => setEditing('new')}>
          <Plus size={13} />
          {t('projects.add')}
        </Button>
      }
    >
      <SettingsCard>
        {loading && projects.length === 0 ? (
          <div className="px-4 py-4 text-fg-muted">
            <Spinner label={t('common.loading')} />
          </div>
        ) : active.length === 0 ? (
          <div className="px-4 py-6 text-center text-sm text-fg-muted">{t('projects.empty')}</div>
        ) : (
          <ul className="flex flex-col">{active.map(row)}</ul>
        )}
      </SettingsCard>
      {archived.length > 0 && (
        <SettingsCard title={t('projects.archivedTitle')}>
          <ul className="flex flex-col">{archived.map(row)}</ul>
        </SettingsCard>
      )}
      <Notice icon={<Info size={14} />}>{t('projects.howItWorks')}</Notice>
      {editing && (
        <ProjectDialog
          workspaceId={workspaceId}
          project={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
        />
      )}
      {deleting && (
        <DeleteProjectDialog workspaceId={workspaceId} project={deleting} onClose={() => setDeleting(null)} />
      )}
    </SettingsPage>
  )
}

function ProjectDialog({
  workspaceId,
  project,
  onClose,
}: {
  workspaceId: string
  project: Project | null
  onClose: () => void
}) {
  const { t } = useTranslation()
  const showToast = useAppStore((s) => s.showToast)
  const create = useProjectStore((s) => s.create)
  const update = useProjectStore((s) => s.update)
  const [draft, setDraft] = useState<Draft>(project ? toDraft(project) : EMPTY_DRAFT)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const set = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }))

  const save = async () => {
    if (!draft.name.trim()) return
    setSaving(true)
    setError(null)
    try {
      if (project) await update(workspaceId, project.id, fromDraft(draft))
      else await create(workspaceId, fromDraft(draft))
      onClose()
    } catch (err) {
      if (isApiError(err, 'conflict')) setError(t('projects.nameTaken'))
      else showToast('error')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal title={project ? t('projects.editTitle') : t('projects.newTitle')} width={480} onClose={onClose}>
      <form
        className="flex flex-col gap-3.5"
        onSubmit={(e) => {
          e.preventDefault()
          void save()
        }}
      >
        <div className="flex flex-col gap-1.5">
          <FieldLabel htmlFor="project-name">{t('projects.name')}</FieldLabel>
          <TextInput
            id="project-name"
            data-autofocus
            value={draft.name}
            maxLength={80}
            onChange={(e) => set({ name: e.target.value })}
            placeholder={t('projects.namePlaceholder')}
          />
          {error && <span className="text-sm text-danger">{error}</span>}
        </div>
        <div className="flex flex-col gap-1.5">
          <FieldLabel htmlFor="project-description">{t('projects.description')}</FieldLabel>
          <TextArea
            id="project-description"
            rows={3}
            maxLength={2000}
            value={draft.description}
            onChange={(e) => set({ description: e.target.value })}
            placeholder={t('projects.descriptionPlaceholder')}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <FieldLabel htmlFor="project-repos" hint={t('projects.reposHint')}>
            {t('projects.repos')}
          </FieldLabel>
          <TextArea
            id="project-repos"
            rows={2}
            value={draft.repos}
            onChange={(e) => set({ repos: e.target.value })}
            placeholder={t('projects.reposPlaceholder')}
            className="font-mono text-sm"
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <FieldLabel htmlFor="project-path">{t('projects.vmPath')}</FieldLabel>
          <TextInput
            id="project-path"
            value={draft.vmPath}
            onChange={(e) => set({ vmPath: e.target.value })}
            placeholder={t('projects.vmPathPlaceholder')}
            className="font-mono text-sm"
          />
        </div>
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" variant="primary" disabled={saving || !draft.name.trim()}>
            {project ? t('common.save') : t('projects.create')}
          </Button>
        </div>
      </form>
    </Modal>
  )
}

function DeleteProjectDialog({
  workspaceId,
  project,
  onClose,
}: {
  workspaceId: string
  project: Project
  onClose: () => void
}) {
  const { t } = useTranslation()
  const remove = useProjectStore((s) => s.remove)
  return (
    <ConfirmDialog
      title={t('projects.deleteTitle', { name: project.name })}
      description={t('projects.deleteDescription')}
      confirmLabel={t('projects.deleteConfirm')}
      onConfirm={() => remove(workspaceId, project.id).then(onClose)}
      onClose={onClose}
    />
  )
}
