import type { EmbeddingModelCandidate, EmbeddingModelCandidates } from '@milibot/shared'
import { ChevronDown, ChevronRight, Search } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { type EmbeddingRow, initialPicks, tokenInputText } from '@/features/providers/lib/provider-form'
import { Button } from '@/ui/Button'
import { Checkbox } from '@/ui/Checkbox'
import { Modal } from '@/ui/Modal'

/**
 * "Fetch models from the server" of the search models table: the server's list with checkboxes.
 * OpenRouter lists only embedding models (with price and context); other servers list everything, so
 * the models whose id looks like an embedding model come first and the rest stay folded.
 */
export function EmbeddingPicker({
  listing,
  providerName,
  rows,
  formatPrice,
  onClose,
  onAdd,
}: {
  listing: EmbeddingModelCandidates
  providerName: string
  rows: EmbeddingRow[]
  formatPrice: (usd: number) => string
  onClose: () => void
  onAdd: (picked: EmbeddingModelCandidate[]) => void
}) {
  const { t } = useTranslation()
  const [picked, setPicked] = useState(() => initialPicks(listing.models, rows, listing.verified))
  const [query, setQuery] = useState('')
  const [showOthers, setShowOthers] = useState(false)
  const registered = useMemo(() => new Set(rows.map((r) => r.modelId)), [rows])

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    const matching = q
      ? listing.models.filter(
          (m) => m.modelId.toLowerCase().includes(q) || m.displayName.toLowerCase().includes(q),
        )
      : listing.models
    return [...matching].sort((a, b) => Number(b.suggested) - Number(a.suggested))
  }, [listing.models, query])
  const likely = visible.filter((m) => listing.verified || m.embedding)
  const others = listing.verified ? [] : visible.filter((m) => !m.embedding)
  const toggle = (id: string) =>
    setPicked((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const row = (m: EmbeddingModelCandidate) => (
    <label
      key={m.modelId}
      className="flex cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1.5 hover:bg-surface-3/60"
    >
      <Checkbox checked={picked.has(m.modelId)} label={m.displayName} onChange={() => toggle(m.modelId)} />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="truncate text-base text-fg">{m.displayName}</span>
          {m.suggested && (
            <span className="shrink-0 rounded-[5px] bg-accent-soft px-1.5 text-2xs leading-4 font-semibold text-accent">
              {t('settings.providers.embedding.picker.suggested')}
            </span>
          )}
          {registered.has(m.modelId) && (
            <span className="shrink-0 text-2xs text-fg-muted">
              {t('settings.providers.embedding.picker.registered')}
            </span>
          )}
        </span>
        {m.displayName !== m.modelId && (
          <span className="truncate font-mono text-2xs text-fg-muted">{m.modelId}</span>
        )}
        {m.description && <span className="truncate text-xs text-fg-secondary">{m.description}</span>}
      </span>
      {m.contextWindow !== null && (
        <span className="shrink-0 font-mono text-xs text-fg-secondary tabular-nums">
          {tokenInputText(m.contextWindow)}
        </span>
      )}
      {m.priceInputPerMtokUsd !== null && (
        <span className="w-[64px] shrink-0 text-right font-mono text-xs text-fg-secondary tabular-nums">
          {formatPrice(m.priceInputPerMtokUsd)}
        </span>
      )}
    </label>
  )

  const chosen = listing.models.filter((m) => picked.has(m.modelId))
  return (
    <Modal
      title={t('settings.providers.embedding.picker.title')}
      description={
        listing.verified
          ? t('settings.providers.embedding.picker.verified', {
              provider: providerName,
              count: listing.models.length,
            })
          : t('settings.providers.embedding.picker.guess')
      }
      width={600}
      onClose={onClose}
      closeLabel={t('common.close')}
    >
      <div className="flex items-center gap-2 rounded-lg border border-border bg-surface px-2.5">
        <Search size={13} className="text-fg-muted" aria-hidden />
        <input
          data-autofocus
          aria-label={t('settings.providers.embedding.picker.filter')}
          placeholder={t('settings.providers.embedding.picker.filter')}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="selectable h-8 flex-1 bg-transparent text-sm text-fg outline-none placeholder:text-fg-muted"
        />
      </div>
      <div className="-mx-2 flex max-h-[380px] flex-col overflow-y-auto">
        {listing.models.length === 0 ? (
          <p className="px-2 py-4 text-center text-sm text-fg-muted">
            {t('settings.providers.embedding.picker.empty')}
          </p>
        ) : visible.length === 0 ? (
          <p className="px-2 py-4 text-center text-sm text-fg-muted">
            {t('settings.providers.embedding.picker.none')}
          </p>
        ) : (
          <>
            {likely.map(row)}
            {others.length > 0 && (
              <>
                <button
                  type="button"
                  aria-expanded={showOthers || query.trim() !== ''}
                  onClick={() => setShowOthers((v) => !v)}
                  className="focus-ring mx-2 mt-1 inline-flex w-fit items-center gap-1 rounded text-sm font-semibold text-fg-secondary hover:text-fg"
                >
                  {showOthers || query.trim() ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                  {t('settings.providers.embedding.picker.others', { count: others.length })}
                </button>
                {(showOthers || query.trim() !== '') && others.map(row)}
              </>
            )}
          </>
        )}
      </div>
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={onClose}>
          {t('common.cancel')}
        </Button>
        <Button size="sm" variant="primary" disabled={chosen.length === 0} onClick={() => onAdd(chosen)}>
          {t('settings.providers.embedding.picker.add', { count: chosen.length })}
        </Button>
      </div>
    </Modal>
  )
}
