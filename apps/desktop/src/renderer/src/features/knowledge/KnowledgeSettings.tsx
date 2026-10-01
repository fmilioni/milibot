import type { KnowledgeDocStatus, KnowledgeKind } from '@milibot/shared'
import { ChevronLeft, ChevronRight, CircleAlert, CloudUpload, FileUp, Info, Upload, X } from 'lucide-react'
import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'

import { formatCount, kindLabel, KNOWLEDGE_KINDS } from '@/features/knowledge/lib/knowledge'
import { useProjectStore } from '@/features/projects/store'
import { Notice, SettingsPage } from '@/features/settings/SettingsLayout'
import { useSettingsStore } from '@/features/settings/store'
import { toastOnError, useAppStore } from '@/features/workspace/store'
import { useWorkspaceId } from '@/features/workspace/use-workspace-id'
import { useFileDrop } from '@/hooks/use-file-drop'
import { cn } from '@/lib/cn'
import { formatBytes } from '@/lib/format'
import type { SelectOption } from '@/lib/select'
import { botOptions, projectOptions } from '@/lib/select-options'
import { AsyncView } from '@/ui/AsyncView'
import { Button } from '@/ui/Button'
import { DropOverlay } from '@/ui/DropOverlay'
import { Select } from '@/ui/Select'
import { Spinner } from '@/ui/Spinner'
import { SearchInput } from '@/ui/TextInput'

import { DocRow } from './DocRow'
import { LegacyOfficeCard } from './LegacyOfficeCard'
import { ModelCard } from './ModelCard'
import { SearchField, SearchResults, useSearchTest } from './SearchTest'
import { EMPTY_FILTERS, type KnowledgeUploadItem, useKnowledgeStore } from './store'

const STATUS_FILTERS: KnowledgeDocStatus[] = [
  'ready',
  'failed',
  'queued',
  'extracting',
  'summarizing',
  'indexing',
]

function Filters() {
  const { t } = useTranslation()
  const bots = useAppStore((s) => s.bots)
  const filters = useKnowledgeStore((s) => s.filters)
  const setFilters = useKnowledgeStore((s) => s.setFilters)
  const workspaceId = useWorkspaceId()
  const projects = useProjectStore((s) => s.projects)
  const filtered = filters.q || filters.kind || filters.author || filters.status || filters.project
  const projectFilters = projectOptions(projects, t, { all: true, includeArchived: true })

  const kinds: SelectOption<string>[] = [
    { value: '', label: t('knowledge.docs.anyKind') },
    ...KNOWLEDGE_KINDS.map((kind) => ({ value: kind, label: kindLabel(kind, t) })),
  ]
  const authors: SelectOption<string>[] = [
    { value: '', label: t('knowledge.docs.anyAuthor') },
    { value: 'user', label: t('knowledge.docs.authorYou') },
    { value: 'bot', label: t('knowledge.docs.authorBots') },
    ...botOptions(bots).map((option) => ({ ...option, group: t('knowledge.docs.authorOneBot') })),
  ]
  const statuses: SelectOption<string>[] = [
    { value: '', label: t('knowledge.docs.anyStatus') },
    ...STATUS_FILTERS.map((status) => ({ value: status, label: t(`knowledge.docs.statuses.${status}`) })),
  ]

  return (
    <div className="flex flex-wrap items-center gap-2">
      <SearchInput
        value={filters.q}
        onChange={(q) => setFilters(workspaceId, { q })}
        placeholder={t('knowledge.docs.filterPlaceholder')}
        className="w-[260px]"
      />
      <div className="w-[150px]">
        <Select
          size="sm"
          tone="surface-2"
          label={t('knowledge.docs.kindFilter')}
          value={filters.kind}
          options={kinds}
          onChange={(kind) => setFilters(workspaceId, { kind: kind as KnowledgeKind | '' })}
        />
      </div>
      <div className="w-[150px]">
        <Select
          size="sm"
          tone="surface-2"
          label={t('knowledge.docs.authorFilter')}
          value={filters.author}
          options={authors}
          onChange={(author) => setFilters(workspaceId, { author })}
        />
      </div>
      {projects.length > 0 && (
        <div className="w-[150px]">
          <Select
            size="sm"
            tone="surface-2"
            label={t('projects.filterLabel')}
            value={filters.project}
            options={projectFilters}
            onChange={(project) => setFilters(workspaceId, { project })}
          />
        </div>
      )}
      <div className="w-[150px]">
        <Select
          size="sm"
          tone="surface-2"
          label={t('knowledge.docs.statusFilter')}
          value={filters.status}
          options={statuses}
          onChange={(status) => setFilters(workspaceId, { status: status as KnowledgeDocStatus | '' })}
        />
      </div>
      {filtered && (
        <Button size="sm" variant="ghost" onClick={() => setFilters(workspaceId, EMPTY_FILTERS)}>
          {t('knowledge.docs.clearFilters')}
        </Button>
      )}
    </div>
  )
}

function UploadRow({ item }: { item: KnowledgeUploadItem }) {
  const { t, i18n } = useTranslation()
  const maxFileMb = useKnowledgeStore((s) => s.maxFileMb)
  const cancelUpload = useKnowledgeStore((s) => s.cancelUpload)
  const dismissUpload = useKnowledgeStore((s) => s.dismissUpload)
  const enableLegacyOffice = useKnowledgeStore((s) => s.enableLegacyOfficeAndRetry)
  const workspaceId = useWorkspaceId()
  const failed = item.problem !== null
  const text = !failed
    ? t('knowledge.upload.sending', { percent: Math.round(item.progress * 100) })
    : item.problem === 'too_large'
      ? t('knowledge.upload.tooLarge', { max: maxFileMb })
      : item.problem === 'unsupported_format'
        ? t('knowledge.upload.unsupported')
        : item.problem === 'legacy_office_disabled'
          ? t('knowledge.upload.legacyOffice')
          : t('knowledge.upload.failed')
  return (
    <li
      className={cn(
        'relative flex items-center gap-3 overflow-hidden rounded-xl border bg-surface-2 px-3.5 py-2.5',
        failed ? 'border-danger-soft' : 'border-border',
      )}
    >
      <span className="flex size-[34px] shrink-0 items-center justify-center rounded-[9px] bg-surface-3 text-fg-secondary">
        <FileUp size={16} aria-hidden />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-base font-semibold text-fg">{item.name}</span>
        <span
          className={cn('flex items-center gap-1 text-xs', failed ? 'text-danger' : 'text-fg-muted')}
          aria-live="polite"
        >
          {failed ? <CircleAlert size={11} className="shrink-0" aria-hidden /> : <Spinner size={11} />}
          {formatBytes(item.size, i18n.language)} · {text}
        </span>
      </div>
      {item.problem === 'legacy_office_disabled' && (
        <Button
          size="sm"
          variant="outline"
          onClick={() => void toastOnError(enableLegacyOffice(workspaceId))}
        >
          {t('knowledge.upload.legacyOfficeAction')}
        </Button>
      )}
      <button
        type="button"
        onClick={() => (failed ? dismissUpload(item.key) : cancelUpload(item.key))}
        aria-label={
          failed ? t('knowledge.upload.dismiss') : t('knowledge.upload.cancel', { name: item.name })
        }
        className="focus-ring flex size-6 shrink-0 items-center justify-center rounded text-fg-muted hover:bg-surface-3 hover:text-fg"
      >
        <X size={13} />
      </button>
      {!failed && (
        <span
          className="absolute bottom-0 left-0 h-[2px] bg-accent transition-[width]"
          style={{ width: `${Math.round(item.progress * 100)}%` }}
        />
      )}
    </li>
  )
}

function Pagination() {
  const { t, i18n } = useTranslation()
  const list = useKnowledgeStore((s) => s.list)
  const setFilters = useKnowledgeStore((s) => s.setFilters)
  const workspaceId = useWorkspaceId()
  if (!list || list.pageCount <= 1) return null
  const from = (list.page - 1) * list.pageSize + 1
  const to = Math.min(list.total, list.page * list.pageSize)
  const button =
    'focus-ring flex size-7 items-center justify-center rounded-md text-fg-secondary hover:bg-surface-3 disabled:opacity-40'
  return (
    <nav
      className="flex items-center justify-end gap-1 text-sm text-fg-secondary"
      aria-label={t('knowledge.docs.title')}
    >
      <span className="mr-1 tabular-nums">
        {t('knowledge.docs.range', {
          from: formatCount(from, i18n.language),
          to: formatCount(to, i18n.language),
          total: formatCount(list.total, i18n.language),
        })}
      </span>
      <button
        type="button"
        className={button}
        aria-label={t('knowledge.docs.previous')}
        disabled={list.page <= 1}
        onClick={() => setFilters(workspaceId, { page: list.page - 1 })}
      >
        <ChevronLeft size={14} />
      </button>
      <button
        type="button"
        className={button}
        aria-label={t('knowledge.docs.next')}
        disabled={list.page >= list.pageCount}
        onClick={() => setFilters(workspaceId, { page: list.page + 1 })}
      >
        <ChevronRight size={14} />
      </button>
    </nav>
  )
}

function Documents() {
  const { t } = useTranslation()
  const list = useKnowledgeStore((s) => s.list)
  const loading = useKnowledgeStore((s) => s.loading)
  const loadError = useKnowledgeStore((s) => s.loadError)
  const uploads = useKnowledgeStore((s) => s.uploads)
  const reload = useKnowledgeStore((s) => s.reload)
  const setFilters = useKnowledgeStore((s) => s.setFilters)
  const workspaceId = useWorkspaceId()
  const search = useSearchTest()
  const totalAll = list?.totalAll ?? 0

  return (
    <section className="mt-2 flex flex-col gap-3" aria-label={t('knowledge.docs.title')}>
      <header className="flex items-center justify-between gap-4">
        <h2 className="flex items-center gap-2 text-md font-semibold text-fg">
          {t('knowledge.docs.title')}
          {list && (
            <span className="rounded-md bg-surface-3 px-[7px] text-xs leading-[17px] font-normal text-fg-secondary tabular-nums">
              {totalAll}
            </span>
          )}
        </h2>
        {totalAll > 0 && <SearchField search={search} />}
      </header>
      <SearchResults search={search} />
      {totalAll > 0 && <Filters />}
      {uploads.length > 0 && (
        <ul className="flex flex-col gap-2">
          {uploads.map((item) => (
            <UploadRow key={item.key} item={item} />
          ))}
        </ul>
      )}
      <AsyncView
        data={list}
        error={loadError}
        errorText={t('knowledge.docs.loadError')}
        onRetry={() => void reload(workspaceId).catch(() => undefined)}
        className="flex items-center justify-center gap-2 rounded-xl border border-dashed border-border px-4 py-6 text-base text-fg-muted"
      >
        {(list) =>
          list.docs.length === 0 ? (
            uploads.length === 0 && (
              <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-border px-4 py-6 text-center text-base text-fg-muted">
                {totalAll === 0 ? (
                  t('knowledge.docs.empty')
                ) : (
                  <>
                    {t('knowledge.docs.noMatches')}
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => setFilters(workspaceId, EMPTY_FILTERS)}
                    >
                      {t('knowledge.docs.clearFilters')}
                    </Button>
                  </>
                )}
              </div>
            )
          ) : (
            <ul className={cn('flex flex-col gap-3.5', loading && 'opacity-80')}>
              {list.docs.map((doc) => (
                <DocRow key={doc.id} doc={doc} />
              ))}
            </ul>
          )
        }
      </AsyncView>
      <Pagination />
    </section>
  )
}

export function KnowledgeSettings() {
  const { t } = useTranslation()
  const workspaceId = useWorkspaceId()
  const showToast = useAppStore((s) => s.showToast)
  const load = useKnowledgeStore((s) => s.load)
  const upload = useKnowledgeStore((s) => s.upload)
  const maxFileMb = useKnowledgeStore((s) => s.maxFileMb)
  const legacyOffice = useSettingsStore(
    (s) => s.workspaceId === workspaceId && s.preferences?.legacyOffice === true,
  )
  const dropText = t(legacyOffice ? 'knowledge.upload.dropLegacy' : 'knowledge.upload.drop', {
    max: maxFileMb,
  })
  const inputRef = useRef<HTMLInputElement>(null)

  const loadProjects = useProjectStore((s) => s.load)

  useEffect(() => {
    void load(workspaceId).catch(() => showToast('error'))
    void loadProjects(workspaceId).catch(() => undefined)
  }, [load, loadProjects, workspaceId, showToast])

  const dragging = useFileDrop((event) => {
    const files = Array.from(event.dataTransfer?.files ?? [])
    if (files.length) upload(workspaceId, files)
  })

  const pick = () => inputRef.current?.click()

  return (
    <SettingsPage
      title={t('knowledge.title')}
      subtitle={t('knowledge.subtitle')}
      width="wide"
      actions={
        <Button variant="primary" onClick={pick}>
          <Upload size={13} />
          {t('knowledge.add')}
        </Button>
      }
    >
      <input
        ref={inputRef}
        type="file"
        multiple
        hidden
        aria-label={t('knowledge.pickTitle')}
        onChange={(e) => {
          const files = Array.from(e.target.files ?? [])
          e.target.value = ''
          if (files.length) upload(workspaceId, files)
        }}
      />
      <ModelCard />
      <LegacyOfficeCard workspaceId={workspaceId} />
      <Documents />
      <button
        type="button"
        onClick={pick}
        className="focus-ring flex min-h-[43px] items-center justify-center gap-2.5 rounded-xl border border-border bg-surface-2 px-4 py-2.5 text-sm text-fg-secondary hover:bg-surface-3/60"
      >
        <CloudUpload size={15} className="shrink-0" aria-hidden />
        {dropText}
      </button>
      <Notice icon={<Info size={14} className="text-fg-secondary" />}>{t('knowledge.note')}</Notice>
      {dragging && (
        <DropOverlay
          icon={<CloudUpload size={24} />}
          title={t('knowledge.upload.dropTitle')}
          hint={dropText}
        />
      )}
    </SettingsPage>
  )
}
