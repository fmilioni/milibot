import type { KnowledgeDoc, KnowledgeKind } from '@milibot/shared'
import {
  Download,
  Eye,
  FileCode,
  FileImage,
  FileText,
  FileX,
  FolderOpen,
  type LucideIcon,
  NotebookText,
  Pencil,
  Pin,
  Presentation,
  RefreshCw,
  ScanText,
  Sheet,
  Trash2,
  Users,
} from 'lucide-react'
import { createElement, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { exportKnowledgeDoc } from '@/features/knowledge/api'
import {
  docDetailLine,
  docErrorView,
  type DocStatusView,
  docStatusView,
  kindLabel,
} from '@/features/knowledge/lib/knowledge'
import { useProjectStore } from '@/features/projects/store'
import { useSettingsStore } from '@/features/settings/store'
import { toastOnError, useAppStore } from '@/features/workspace/store'
import { useApiMutation } from '@/features/workspace/use-api-mutation'
import { useWorkspaceId } from '@/features/workspace/use-workspace-id'
import { cn } from '@/lib/cn'
import { botOptions, GENERAL_PROJECT, projectOptions } from '@/lib/select-options'
import type { Tone } from '@/lib/tone'
import type { MenuEntry } from '@/ui/Menu'
import { MoreMenu } from '@/ui/MoreMenu'
import { MultiSelect } from '@/ui/MultiSelect'
import { Select } from '@/ui/Select'
import { StatusDot, Tag } from '@/ui/Tag'
import { Tooltip } from '@/ui/Tooltip'

import { ContentModal, DeleteModal, RenameModal } from './DocModals'
import { useOfficeStore } from './office-store'
import { useKnowledgeStore } from './store'

const KIND_ICONS: Partial<Record<KnowledgeKind, LucideIcon>> = {
  csv: Sheet,
  xlsx: Sheet,
  image: FileImage,
  code: FileCode,
  json: FileCode,
  pptx: Presentation,
  note: NotebookText,
}

function docIcon(doc: KnowledgeDoc): LucideIcon {
  if (doc.status === 'failed') return FileX
  if (doc.ocrPages > 0) return ScanText
  return KIND_ICONS[doc.kind] ?? FileText
}

const DOT: Record<DocStatusView['tone'], Tone> = {
  success: 'success',
  progress: 'accent',
  warning: 'warning',
  danger: 'danger',
  neutral: 'muted',
}

const STATUS_TEXT: Record<DocStatusView['tone'], string> = {
  success: 'text-fg-muted',
  progress: 'text-accent',
  warning: 'text-warning',
  danger: 'text-danger',
  neutral: 'text-fg-muted',
}

type Dialog = 'content' | 'rename' | 'delete' | null

export function DocRow({ doc }: { doc: KnowledgeDoc }) {
  const { t, i18n } = useTranslation()
  const workspaceId = useWorkspaceId()
  const bots = useAppStore((s) => s.bots)
  const conversations = useAppStore((s) => s.conversations)
  const vmRunning = useAppStore((s) => s.vm?.state === 'running')
  const showToast = useAppStore((s) => s.showToast)
  const openSettings = useAppStore((s) => s.openSettings)
  const updateDoc = useKnowledgeStore((s) => s.updateDoc)
  const reindexDoc = useKnowledgeStore((s) => s.reindexDoc)
  const [dialog, setDialog] = useState<Dialog>(null)

  const status = docStatusView(doc, vmRunning, t)
  const detail = docDetailLine(doc, { bots, conversations, vmRunning }, t, i18n.language)
  const error = doc.status === 'failed' ? docErrorView(doc, t) : null
  const scope = doc.scope === 'all' ? 'all' : doc.scope.filter((id) => bots[id])
  const projects = useProjectStore((s) => s.projects)
  const projectChoices = projectOptions(
    projects.filter((p) => !p.archivedAt || p.id === doc.projectId),
    t,
    { includeArchived: true },
  )

  const { run: download } = useApiMutation(
    async () => {
      const { path, fileName } = await exportKnowledgeDoc(workspaceId, doc.id)
      return window.milibot.saveFileAs({
        sourcePath: path,
        defaultName: fileName,
        title: t('knowledge.downloadTitle'),
      })
    },
    { onSuccess: (saved) => saved && showToast('knowledgeSaved') },
  )

  const entries: MenuEntry[] = [
    {
      key: 'view',
      label: t('knowledge.menu.view'),
      icon: <Eye size={14} />,
      onSelect: () => setDialog('content'),
    },
    {
      key: 'download',
      label: t('knowledge.menu.download'),
      icon: <Download size={14} />,
      onSelect: () => void download(),
    },
    {
      key: 'rename',
      label: t('knowledge.menu.rename'),
      icon: <Pencil size={14} />,
      onSelect: () => setDialog('rename'),
    },
    {
      key: 'reindex',
      label: t('knowledge.menu.reindex'),
      icon: <RefreshCw size={14} />,
      disabled: doc.status !== 'ready' && doc.status !== 'failed',
      onSelect: () => void toastOnError(reindexDoc(workspaceId, doc.id)),
    },
    { type: 'separator', key: 'sep' },
    {
      key: 'delete',
      label: t('knowledge.menu.delete'),
      icon: <Trash2 size={14} />,
      danger: true,
      onSelect: () => setDialog('delete'),
    },
  ]

  return (
    <li className="group flex items-center gap-3 rounded-xl border border-border bg-surface-2 px-3.5 py-[11px]">
      <span
        className={cn(
          'flex size-[34px] shrink-0 items-center justify-center rounded-[9px] bg-surface-3',
          doc.status === 'failed' ? 'text-danger' : 'text-fg',
        )}
      >
        {createElement(docIcon(doc), { size: 16, 'aria-hidden': true })}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex min-w-0 items-center gap-2">
          <button
            type="button"
            onClick={() => setDialog('content')}
            className="focus-ring min-w-0 truncate rounded text-left text-md font-semibold text-fg hover:underline"
          >
            {doc.title}
          </button>
          <Tag>{kindLabel(doc.kind, t)}</Tag>
          <span className="flex shrink-0 items-center gap-[5px]" aria-live="polite">
            <StatusDot tone={DOT[status.tone]} pulse={status.tone === 'progress'} />
            <Tooltip content={doc.status === 'failed' ? doc.error : null} maxWidth={420}>
              <span className={`text-xs ${STATUS_TEXT[status.tone]}`}>{status.label}</span>
            </Tooltip>
          </span>
          {status.progress !== null && (
            <span className="h-1 w-[120px] shrink-0 overflow-hidden rounded-full bg-surface-3" aria-hidden>
              <span
                className="block h-full rounded-full bg-accent transition-[width]"
                style={{ width: `${Math.round(status.progress * 100)}%` }}
              />
            </span>
          )}
        </div>
        <div className="flex min-w-0 items-center gap-2 text-xs text-fg-muted">
          <Tooltip content={doc.summary} maxWidth={420}>
            <span className="truncate">{detail}</span>
          </Tooltip>
          {error?.legacyOffice && (
            <button
              type="button"
              onClick={() =>
                void toastOnError(
                  error.legacyOffice === 'enable'
                    ? useSettingsStore.getState().updatePreferences(workspaceId, { legacyOffice: true })
                    : useOfficeStore.getState().retry(workspaceId),
                )
              }
              className="focus-ring shrink-0 rounded font-semibold text-accent hover:underline"
            >
              {t(error.legacyOffice === 'enable' ? 'knowledge.legacyOffice.enable' : 'common.retry')}
            </button>
          )}
          {error?.updateSystem && (
            <button
              type="button"
              onClick={() => openSettings('vm')}
              className="focus-ring shrink-0 rounded font-semibold text-accent hover:underline"
            >
              {t('knowledge.updateSystem')}
            </button>
          )}
        </div>
      </div>
      <Tooltip content={doc.pinned ? t('knowledge.pinnedHint') : t('knowledge.pinHint')} maxWidth={280}>
        <button
          type="button"
          aria-pressed={doc.pinned}
          aria-label={doc.pinned ? t('knowledge.unpin') : t('knowledge.pin')}
          onClick={() => void toastOnError(updateDoc(workspaceId, doc.id, { pinned: !doc.pinned }))}
          className={cn(
            'focus-ring flex size-6 shrink-0 items-center justify-center rounded hover:bg-surface-3',
            doc.pinned
              ? 'text-accent'
              : 'text-fg-muted opacity-0 group-focus-within:opacity-100 group-hover:opacity-100',
          )}
        >
          <Pin size={13} className={doc.pinned ? 'fill-current' : ''} />
        </button>
      </Tooltip>
      {(projects.length > 0 || doc.projectId) && (
        <div className="w-[130px] shrink-0">
          <Select
            size="sm"
            tone="surface-2"
            label={t('projects.docProject', { name: doc.title })}
            value={doc.projectId ?? GENERAL_PROJECT}
            options={projectChoices}
            renderValue={(option) => (
              <span className="flex min-w-0 items-center gap-1">
                <FolderOpen size={12} className="shrink-0 text-fg-muted" aria-hidden />
                <span className="truncate">{option?.label ?? '…'}</span>
              </span>
            )}
            onChange={(value) =>
              void toastOnError(
                updateDoc(workspaceId, doc.id, { projectId: value === GENERAL_PROJECT ? null : value }),
              )
            }
          />
        </div>
      )}
      <div className="flex max-w-[260px] min-w-0 shrink-0 justify-end">
        <MultiSelect
          variant="chips"
          icon={<Users size={12} aria-hidden />}
          value={scope}
          options={botOptions(bots)}
          label={t('knowledge.access.label', { name: doc.title })}
          allLabel={t('knowledge.access.all')}
          placeholder={t('knowledge.access.none')}
          onChange={(value) => void toastOnError(updateDoc(workspaceId, doc.id, { scope: value }))}
        />
      </div>
      <MoreMenu
        label={t('knowledge.menu.more', { name: doc.title })}
        entries={entries}
        width={210}
        menuLabel={doc.title}
      />
      {dialog === 'content' && <ContentModal doc={doc} onClose={() => setDialog(null)} />}
      {dialog === 'rename' && <RenameModal doc={doc} onClose={() => setDialog(null)} />}
      {dialog === 'delete' && <DeleteModal doc={doc} onClose={() => setDialog(null)} />}
    </li>
  )
}
