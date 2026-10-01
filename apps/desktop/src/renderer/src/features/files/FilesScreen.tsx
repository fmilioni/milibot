import type { ChatFile, FileSource } from '@milibot/shared'
import { FolderOpen, Search } from 'lucide-react'
import { Fragment, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { type FileGroupKey, groupFiles, monthLabel } from '@/features/files/lib/files'
import { useAppStore } from '@/features/workspace/store'
import { useWorkspaceId } from '@/features/workspace/use-workspace-id'
import { useNow } from '@/hooks/use-now'
import { formatBytes } from '@/lib/format'
import { ConfirmDialog } from '@/ui/Confirm'
import { EmptyState } from '@/ui/EmptyState'
import { RenameDialog } from '@/ui/RenameDialog'
import { Segmented } from '@/ui/Segmented'
import { SearchInput } from '@/ui/TextInput'

import { COL, FileRow } from './FileRow'
import { fileErrorCode, fileErrorToast, useFilesStore } from './store'

type SourceFilter = 'all' | FileSource

const NO_FILES: ChatFile[] = []
const SOURCES: SourceFilter[] = ['all', 'bots', 'user']

/** Every file sent in the workspace's chats (by the user or the bots), grouped by day; they live in the VM. */
export function FilesScreen() {
  const { t, i18n } = useTranslation()
  const workspaceId = useWorkspaceId()
  const showToast = useAppStore((s) => s.showToast)
  const files = useFilesStore((s) => (s.workspaceId === workspaceId ? s.files : NO_FILES))
  const loaded = useFilesStore((s) => s.workspaceId === workspaceId && s.loaded)
  const hasMore = useFilesStore((s) => s.hasMore)
  const loading = useFilesStore((s) => s.loading)
  const counts = useFilesStore((s) => s.counts)
  const totalBytes = useFilesStore((s) => s.totalBytes)
  const filter = useFilesStore((s) => s.filter)
  const load = useFilesStore((s) => s.load)
  const loadMore = useFilesStore((s) => s.loadMore)
  const [query, setQuery] = useState(filter.query)
  const [renaming, setRenaming] = useState<ChatFile | null>(null)
  const [deleting, setDeleting] = useState<ChatFile | null>(null)
  const source: SourceFilter = filter.source ?? 'all'
  const now = useNow(60_000)
  const groups = useMemo(() => groupFiles(files, now), [files, now])

  useEffect(() => {
    const timer = setTimeout(
      () => void load(workspaceId, { query }).catch(() => showToast('error')),
      query === useFilesStore.getState().filter.query ? 0 : 250,
    )
    return () => clearTimeout(timer)
  }, [load, workspaceId, query, showToast])

  const setSource = (value: SourceFilter) =>
    void load(workspaceId, { source: value === 'all' ? null : value }).catch(() => showToast('error'))

  const groupLabel = (key: FileGroupKey) => {
    if (key === 'today') return t('time.today')
    if (key === 'yesterday') return t('time.yesterdayTitle')
    if (key === 'week') return t('files.groups.week')
    const month = monthLabel(key, i18n.language) ?? ''
    return month.charAt(0).toUpperCase() + month.slice(1)
  }

  return (
    <main className="flex min-w-0 flex-1 flex-col bg-bg" aria-label={t('files.title')}>
      <header className="drag-region flex shrink-0 flex-col gap-[18px] px-10 pt-7 pb-5 win:pr-caption-10">
        <div className="flex items-center gap-4">
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <h1 className="text-4xl font-bold text-fg">{t('files.title')}</h1>
            <p className="text-base text-fg-secondary">{t('files.subtitle')}</p>
          </div>
          <SearchInput
            value={query}
            onChange={setQuery}
            placeholder={t('files.search')}
            className="no-drag w-[260px] shrink-0"
          />
        </div>
        <div className="flex items-center gap-3">
          <Segmented
            size="sm"
            role="tab"
            value={source}
            onChange={setSource}
            label={t('files.filters.label')}
            className="no-drag"
            options={SOURCES.map((value) => ({
              value,
              label: t(`files.filters.${value}`),
              count: counts[value],
            }))}
          />
          <span className="flex-1" />
          {loaded && counts.all > 0 && (
            <span className="text-sm text-fg-muted">
              {t('files.total', { count: counts.all, size: formatBytes(totalBytes, i18n.language) })}
            </span>
          )}
        </div>
      </header>

      <div className="scroll-slim flex min-h-0 flex-1 flex-col overflow-y-auto px-10 pb-8">
        {loaded && files.length === 0 ? (
          counts.all === 0 && !filter.query.trim() ? (
            <EmptyState icon={FolderOpen} title={t('files.empty.title')} hint={t('files.empty.hint')} />
          ) : (
            <EmptyState
              icon={filter.query.trim() ? Search : FolderOpen}
              title={t(filter.query.trim() ? 'files.emptySearch.title' : `files.emptySource.${source}`)}
              hint={t(filter.query.trim() ? 'files.emptySearch.hint' : 'files.emptySource.hint')}
            />
          )
        ) : (
          files.length > 0 && (
            <div className="overflow-hidden rounded-xl border border-border bg-surface" role="table">
              <div
                role="row"
                className="flex items-center gap-4 border-b border-border px-4 py-2.5 text-xs font-semibold tracking-[0.03em] text-fg-muted uppercase"
              >
                <span role="columnheader" className="min-w-0 flex-1">
                  {t('files.columns.name')}
                </span>
                <span role="columnheader" className={COL.sender}>
                  {t('files.columns.sender')}
                </span>
                <span role="columnheader" className={COL.chat}>
                  {t('files.columns.chat')}
                </span>
                <span role="columnheader" className={`${COL.size} text-right`}>
                  {t('files.columns.size')}
                </span>
                <span role="columnheader" className={`${COL.when} text-right`}>
                  {t('files.columns.when')}
                </span>
                <span className={COL.actions} />
              </div>
              {groups.map((group) => (
                <Fragment key={group.key}>
                  <div className="px-4 pt-3.5 pb-1.5 text-sm font-semibold text-fg-secondary" role="row">
                    {groupLabel(group.key)}
                  </div>
                  {group.items.map((file, i) => (
                    <FileRow
                      key={file.attachment.id}
                      file={file}
                      exactTime={group.key === 'today' || group.key === 'yesterday'}
                      last={i === group.items.length - 1}
                      onRename={() => setRenaming(file)}
                      onDelete={() => setDeleting(file)}
                    />
                  ))}
                </Fragment>
              ))}
            </div>
          )
        )}
        {hasMore && (
          <div className="flex justify-center py-3">
            <button
              type="button"
              disabled={loading}
              onClick={() => void loadMore(workspaceId).catch(() => showToast('error'))}
              className="focus-ring rounded-lg px-3 py-1.5 text-base text-fg-secondary hover:bg-surface-2 disabled:opacity-60"
            >
              {t('files.more')}
            </button>
          </div>
        )}
      </div>

      {renaming && (
        <RenameDialog
          title={t('files.rename.title')}
          label={t('files.rename.label')}
          initial={renaming.attachment.name}
          maxLength={255}
          selectStem
          onSave={(name) => useFilesStore.getState().rename(workspaceId, renaming.attachment.id, name)}
          errorText={(err) =>
            fileErrorCode(err) === 'NAME_TAKEN' ? t('files.rename.taken') : t(`toast.${fileErrorToast(err)}`)
          }
          onClose={() => setRenaming(null)}
        />
      )}
      {deleting && (
        <ConfirmDialog
          title={t('files.delete.title', { name: deleting.attachment.name })}
          description={t('files.delete.description')}
          confirmLabel={t('files.delete.confirm')}
          onConfirm={() =>
            useFilesStore
              .getState()
              .remove(workspaceId, deleting.attachment.id)
              .then(() => setDeleting(null))
          }
          errorText={t('files.delete.failed')}
          onClose={() => setDeleting(null)}
        />
      )}
    </main>
  )
}
