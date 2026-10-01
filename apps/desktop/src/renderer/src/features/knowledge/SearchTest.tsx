import type { KnowledgeDoc, KnowledgeSearchResult } from '@milibot/shared'
import { Search, X } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { getKnowledgeDoc, searchKnowledge } from '@/features/knowledge/api'
import { hitLocation, kindLabel, snippetText } from '@/features/knowledge/lib/knowledge'
import { toastOnError } from '@/features/workspace/store'
import { useWorkspaceId } from '@/features/workspace/use-workspace-id'
import { Spinner } from '@/ui/Spinner'
import { Tag } from '@/ui/Tag'

import { ContentModal } from './DocModals'

type SearchState =
  | { phase: 'idle' }
  | { phase: 'running'; query: string }
  | { phase: 'done'; query: string; result: KnowledgeSearchResult }
  | { phase: 'error'; query: string }

/** "Test a search": the field in the documents header and, below it, the passages found. */
export function useSearchTest() {
  const workspaceId = useWorkspaceId()
  const [query, setQuery] = useState('')
  const [state, setState] = useState<SearchState>({ phase: 'idle' })

  const run = () => {
    const q = query.trim()
    if (!q) return
    setState({ phase: 'running', query: q })
    searchKnowledge(workspaceId, q)
      .then((result) => setState({ phase: 'done', query: q, result }))
      .catch(() => setState({ phase: 'error', query: q }))
  }
  const clear = () => {
    setQuery('')
    setState({ phase: 'idle' })
  }
  return { query, setQuery, state, run, clear }
}

export function SearchField({ search }: { search: ReturnType<typeof useSearchTest> }) {
  const { t } = useTranslation()
  return (
    <form
      role="search"
      className="relative w-[360px] max-w-full"
      onSubmit={(e) => {
        e.preventDefault()
        search.run()
      }}
    >
      <Search
        size={13}
        className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-fg-muted"
        aria-hidden
      />
      <input
        type="search"
        value={search.query}
        onChange={(e) => search.setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && search.query) {
            e.preventDefault()
            e.stopPropagation()
            search.clear()
          }
        }}
        placeholder={t('knowledge.search.placeholder')}
        aria-label={t('knowledge.search.label')}
        className="selectable h-[29px] w-full rounded-lg border border-border bg-surface-2 pr-8 pl-[31px] text-sm text-fg outline-none placeholder:text-fg-muted focus:border-accent [&::-webkit-search-cancel-button]:hidden"
      />
      {search.state.phase === 'running' ? (
        <Spinner size={13} className="absolute top-1/2 right-2.5 -translate-y-1/2 text-fg-muted" />
      ) : (
        search.query && (
          <button
            type="button"
            onClick={search.clear}
            aria-label={t('knowledge.search.clear')}
            className="focus-ring absolute top-1/2 right-1.5 flex size-5 -translate-y-1/2 items-center justify-center rounded text-fg-muted hover:bg-surface-3"
          >
            <X size={12} />
          </button>
        )
      )}
    </form>
  )
}

export function SearchResults({ search }: { search: ReturnType<typeof useSearchTest> }) {
  const { t } = useTranslation()
  const workspaceId = useWorkspaceId()
  const [open, setOpen] = useState<KnowledgeDoc | null>(null)
  const { state } = search
  if (state.phase === 'idle' || state.phase === 'running') return null

  const openDoc = (docId: string) => void toastOnError(getKnowledgeDoc(workspaceId, docId).then(setOpen))

  return (
    <section
      aria-label={t('knowledge.search.label')}
      className="flex flex-col rounded-xl border border-border bg-surface-2"
    >
      <header className="flex items-center gap-2 border-b border-border px-4 py-2.5">
        <Search size={13} className="shrink-0 text-fg-muted" aria-hidden />
        <span className="min-w-0 flex-1 truncate text-sm text-fg-secondary">
          <span className="font-semibold text-fg">“{state.query}”</span>
          {state.phase === 'done' && state.result.hits.length > 0 && (
            <>
              {' · '}
              {t('knowledge.search.summary', {
                count: state.result.hits.length,
                ms: state.result.tookMs,
                mode: t(`knowledge.search.${state.result.mode}`),
              })}
            </>
          )}
        </span>
        <button
          type="button"
          onClick={search.clear}
          aria-label={t('knowledge.search.clear')}
          className="focus-ring flex size-6 items-center justify-center rounded text-fg-muted hover:bg-surface-3"
        >
          <X size={13} />
        </button>
      </header>
      {state.phase === 'error' ? (
        <p className="px-4 py-4 text-sm text-danger">{t('knowledge.search.error')}</p>
      ) : state.result.hits.length === 0 ? (
        <p className="px-4 py-4 text-sm text-fg-muted">{t('knowledge.search.none')}</p>
      ) : (
        <ol className="flex flex-col">
          {state.result.hits.map((hit, i) => {
            const location = hitLocation(hit, t)
            return (
              <li
                key={`${hit.docId}-${hit.fromChunk}`}
                className="flex gap-3 px-4 py-3 [&+&]:border-t [&+&]:border-border"
              >
                <span className="mt-px flex size-5 shrink-0 items-center justify-center rounded-md bg-surface-3 text-xs font-semibold text-fg-secondary tabular-nums">
                  {i + 1}
                </span>
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  <div className="flex min-w-0 items-center gap-2">
                    <button
                      type="button"
                      onClick={() => openDoc(hit.docId)}
                      title={t('knowledge.search.open')}
                      className="focus-ring min-w-0 truncate rounded text-left text-base font-semibold text-fg hover:underline"
                    >
                      {hit.title}
                    </button>
                    <Tag>{kindLabel(hit.kind, t)}</Tag>
                    {location && <span className="min-w-0 truncate text-xs text-fg-muted">{location}</span>}
                  </div>
                  <p className="selectable line-clamp-3 text-sm leading-[17px] whitespace-pre-line text-fg-secondary">
                    {snippetText(hit.text)}
                  </p>
                </div>
              </li>
            )
          })}
        </ol>
      )}
      {open && <ContentModal doc={open} onClose={() => setOpen(null)} />}
    </section>
  )
}
