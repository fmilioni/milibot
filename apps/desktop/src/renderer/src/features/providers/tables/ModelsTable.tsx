import { ChevronRight, Feather, Image, Wrench } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { type ModelRow, tokenInputText } from '@/features/providers/lib/provider-form'
import { COMPACT_INPUT } from '@/features/settings/SettingsLayout'
import { cn } from '@/lib/cn'
import { Switch } from '@/ui/Switch'
import { SearchInput } from '@/ui/TextInput'
import { Tooltip } from '@/ui/Tooltip'

import { effortsSummary } from '../EffortsField'
import { patchRow, RemoveRowButton, type SetRows } from './cells'
import { ModelDetails } from './ModelDetails'

const MAX_ROWS = 60

function ModelSummary({ row, light }: { row: ModelRow; light: boolean }) {
  const { t, i18n } = useTranslation()
  const number = new Intl.NumberFormat(i18n.language, { maximumFractionDigits: 4 })
  const price = (usd: number | null) => (usd === null ? '—' : number.format(usd))
  const parts = [
    row.contextWindow &&
      t('settings.providers.table.summary.context', { value: tokenInputText(row.contextWindow) }),
    row.maxOutputTokens &&
      t('settings.providers.table.summary.maxOutput', { value: tokenInputText(row.maxOutputTokens) }),
    row.efforts !== null &&
      t('settings.providers.table.summary.efforts', { value: effortsSummary(t, row.efforts) }),
  ].filter(Boolean)
  const hasPrice = row.priceInputPerMtokUsd !== null || row.priceOutputPerMtokUsd !== null
  const capabilities = [
    {
      on: row.supportsTools,
      Icon: Wrench,
      label: t(`settings.providers.table.${row.supportsTools ? 'tools' : 'noTools'}`),
    },
    {
      on: row.supportsVision,
      Icon: Image,
      label: t(`settings.providers.table.${row.supportsVision ? 'vision' : 'noVision'}`),
    },
  ]
  return (
    <span className="flex min-w-0 items-center gap-2 text-xs text-fg-muted">
      {light && (
        <Tooltip content={t('settings.providers.table.lightHint')}>
          <span className="inline-flex h-[18px] shrink-0 items-center gap-1 rounded-md bg-accent/15 px-1.5 text-2xs font-medium text-accent">
            <Feather size={10} aria-hidden />
            {t('settings.providers.table.lightBadge')}
          </span>
        </Tooltip>
      )}
      {capabilities.map(({ on, Icon, label }) => (
        <Tooltip key={label} content={label}>
          <span aria-label={label} className={on ? 'text-fg-secondary' : 'opacity-35'}>
            <Icon size={12} aria-hidden />
          </span>
        </Tooltip>
      ))}
      <span className="@min-[560px]:truncate">
        {[
          ...parts,
          ...(hasPrice
            ? [
                t('settings.providers.table.summary.prices', {
                  input: price(row.priceInputPerMtokUsd),
                  output: price(row.priceOutputPerMtokUsd),
                }),
              ]
            : []),
        ].join(' · ')}
      </span>
    </span>
  )
}

export function ModelsTable({
  rows,
  setRows,
  lightModel,
  onLightModelChange,
}: {
  rows: ModelRow[]
  setRows: SetRows<ModelRow>
  /** The provider's light model (only an enabled row shows it). */
  lightModel: string | null
  onLightModelChange: (modelId: string | null) => void
}) {
  const { t } = useTranslation()
  const [query, setQuery] = useState('')
  // Keys whose expanded state differs from the default (open only while a manual row has no id yet).
  const [toggled, setToggled] = useState<ReadonlySet<string>>(new Set())
  const set = (key: string, patch: Partial<ModelRow>) => patchRow(setRows, key, patch)
  const toggle = (key: string) =>
    setToggled((all) => {
      const next = new Set(all)
      if (!next.delete(key)) next.add(key)
      return next
    })
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    const matching = q
      ? rows.filter((r) => r.modelId.toLowerCase().includes(q) || r.displayName.toLowerCase().includes(q))
      : rows
    // Enabled models first so a long fetched list still shows what is in use.
    return [...matching].sort((a, b) => Number(b.enabled) - Number(a.enabled)).slice(0, MAX_ROWS)
  }, [rows, query])
  return (
    <div className="@container flex flex-col overflow-hidden rounded-[10px] border border-border">
      {rows.length > 12 && (
        <div className="flex items-center gap-2 border-b border-border bg-surface px-3 py-1.5">
          <SearchInput
            value={query}
            onChange={setQuery}
            placeholder={t('settings.providers.table.search')}
            className="flex-1"
          />
          <span className="text-xs text-fg-muted">
            {t('settings.providers.table.count', {
              count: rows.length,
              enabled: rows.filter((r) => r.enabled).length,
            })}
          </span>
        </div>
      )}
      {filtered.length === 0 ? (
        <div className="px-3 py-4 text-center text-sm text-fg-muted">
          {t('settings.providers.table.empty')}
        </div>
      ) : (
        filtered.map((row, index) => {
          const editingId = row.manual && !row.id
          const open = editingId !== toggled.has(row.key)
          const name = row.displayName || row.modelId
          const light = row.enabled && !!row.modelId && row.modelId === lightModel
          return (
            <div
              key={row.key}
              role="row"
              className={cn('px-3 py-2', index > 0 && 'border-t border-border', open && 'bg-surface/60')}
            >
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  aria-expanded={open}
                  aria-label={t('settings.providers.table.details', { name })}
                  onClick={() => toggle(row.key)}
                  className={cn(
                    'focus-ring flex min-w-0 items-center gap-2 rounded text-left',
                    editingId ? 'shrink-0' : 'flex-1',
                    !row.enabled && 'opacity-60',
                  )}
                >
                  <ChevronRight
                    size={14}
                    aria-hidden
                    className={cn('shrink-0 text-fg-muted transition-transform', open && 'rotate-90')}
                  />
                  {!editingId && (
                    <span className="flex min-w-0 flex-1 flex-col gap-1 @min-[560px]:flex-row @min-[560px]:items-center @min-[560px]:gap-3">
                      <span className="flex min-w-0 flex-col @min-[560px]:flex-1 @min-[560px]:basis-[200px]">
                        <span className="truncate text-base text-fg">{name}</span>
                        <span className="selectable truncate font-mono text-2xs text-fg-muted">
                          {row.modelId}
                        </span>
                      </span>
                      {!open && (
                        <span className="flex min-w-0 @min-[560px]:ml-auto @min-[560px]:justify-end">
                          <ModelSummary row={row} light={light} />
                        </span>
                      )}
                    </span>
                  )}
                </button>
                {editingId && (
                  <input
                    aria-label={t('settings.providers.table.modelId')}
                    placeholder={t('settings.providers.table.modelIdPlaceholder')}
                    value={row.modelId}
                    autoFocus
                    onChange={(e) => {
                      const modelId = e.target.value.trim()
                      const followsId = !row.displayName || row.displayName === row.modelId
                      set(row.key, followsId ? { modelId, displayName: modelId } : { modelId })
                    }}
                    className={`${COMPACT_INPUT} h-[26px] min-w-0 flex-1 font-mono`}
                  />
                )}
                <Switch
                  checked={row.enabled}
                  label={t('settings.providers.table.enable', { name })}
                  onChange={(enabled) => set(row.key, { enabled })}
                />
                <RemoveRowButton
                  name={name}
                  onRemove={() => setRows((all) => all.filter((r) => r.key !== row.key))}
                />
              </div>
              {open && (
                <ModelDetails
                  row={row}
                  set={(patch) => set(row.key, patch)}
                  light={light}
                  onLightChange={(on) => onLightModelChange(on ? row.modelId : null)}
                />
              )}
            </div>
          )
        })
      )}
    </div>
  )
}
