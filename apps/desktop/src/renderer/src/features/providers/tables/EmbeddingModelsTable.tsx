import type { EmbeddingProbeErrorCode } from '@milibot/shared'
import { Check, X, Zap } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import type { EmbeddingRow } from '@/features/providers/lib/provider-form'
import { COMPACT_INPUT } from '@/features/settings/SettingsLayout'
import { cn } from '@/lib/cn'
import { Spinner } from '@/ui/Spinner'
import { Switch } from '@/ui/Switch'
import { Tooltip } from '@/ui/Tooltip'

import { patchRow, PriceInput, RemoveRowButton, type SetRows, TokenInput } from './cells'

export type EmbeddingTest =
  | { status: 'testing' }
  | { status: 'ok'; dimensions: number }
  | { status: 'failed'; code: EmbeddingProbeErrorCode; error: string | null }

export function EmbeddingModelsTable({
  rows,
  setRows,
  tests,
  onTest,
}: {
  rows: EmbeddingRow[]
  setRows: SetRows<EmbeddingRow>
  tests: Record<string, EmbeddingTest>
  onTest: (row: EmbeddingRow) => void
}) {
  const { t, i18n } = useTranslation()
  const set = (key: string, patch: Partial<EmbeddingRow>) => patchRow(setRows, key, patch)
  const grid = 'grid grid-cols-[minmax(0,1fr)_80px_84px_72px_74px_36px_22px] items-center gap-x-1.5'
  const dims = (n: number) => new Intl.NumberFormat(i18n.language).format(n)
  return (
    <div className="flex flex-col overflow-hidden rounded-[10px] border border-border">
      <div role="row" className={`${grid} bg-surface-3/70 px-3 py-1.5 text-xs font-medium text-fg-secondary`}>
        <span role="columnheader">{t('settings.providers.table.model')}</span>
        <span role="columnheader">{t('settings.providers.embedding.dimensions')}</span>
        <span role="columnheader" className="truncate">
          {t('settings.providers.embedding.maxInput')}
        </span>
        <span role="columnheader">{t('settings.providers.embedding.price')}</span>
        <span className="sr-only">{t('settings.providers.embedding.test')}</span>
        <span className="sr-only">{t('settings.providers.table.enabled')}</span>
        <span />
      </div>
      {rows.length === 0 ? (
        <div className="px-3 py-4 text-center text-sm text-fg-muted">
          {t('settings.providers.embedding.empty')}
        </div>
      ) : (
        rows.map((row) => {
          const test = tests[row.key]
          return (
            <div
              key={row.key}
              role="row"
              className={cn('border-t border-border px-3 py-1.5', !row.enabled && 'opacity-60')}
            >
              <div className={grid}>
                <div className="flex min-w-0 flex-col">
                  {row.manual && !row.id ? (
                    <input
                      aria-label={t('settings.providers.table.modelId')}
                      placeholder={t('settings.providers.table.modelIdPlaceholder')}
                      value={row.modelId}
                      autoFocus
                      onChange={(e) =>
                        set(row.key, {
                          modelId: e.target.value.trim(),
                          displayName: e.target.value.trim(),
                          dimensions: null,
                        })
                      }
                      className={`${COMPACT_INPUT} h-[26px] font-mono`}
                    />
                  ) : (
                    <>
                      <span className="truncate text-base text-fg">{row.displayName}</span>
                      {row.displayName !== row.modelId && (
                        <span className="selectable truncate font-mono text-2xs text-fg-muted">
                          {row.modelId}
                        </span>
                      )}
                    </>
                  )}
                </div>
                <span className="font-mono text-sm text-fg-secondary tabular-nums">
                  {row.dimensions ? (
                    dims(row.dimensions)
                  ) : (
                    <Tooltip content={t('settings.providers.embedding.dimensionsUnknown')}>
                      <span className="text-fg-muted">—</span>
                    </Tooltip>
                  )}
                </span>
                <TokenInput
                  label={`${t('settings.providers.embedding.maxInput')} · ${row.modelId}`}
                  hint={t('settings.providers.embedding.maxInputHint')}
                  value={row.contextWindow}
                  disabled={!row.enabled}
                  onChange={(contextWindow) => set(row.key, { contextWindow })}
                />
                <PriceInput
                  label={`${t('settings.providers.embedding.price')} · ${row.modelId}`}
                  value={row.priceInputPerMtokUsd}
                  disabled={!row.enabled}
                  onChange={(priceInputPerMtokUsd) => set(row.key, { priceInputPerMtokUsd })}
                />
                <button
                  type="button"
                  disabled={!row.modelId.trim() || test?.status === 'testing'}
                  aria-label={t('settings.providers.embedding.testName', {
                    name: row.displayName || row.modelId,
                  })}
                  onClick={() => onTest(row)}
                  className="focus-ring inline-flex h-[24px] items-center justify-center gap-1 rounded-[6px] border border-border px-2 text-xs font-semibold text-fg-secondary hover:bg-surface-3 disabled:opacity-50"
                >
                  {test?.status === 'testing' ? (
                    <Spinner size={11} />
                  ) : test?.status === 'ok' ? (
                    <Check size={11} className="text-success" aria-hidden />
                  ) : test?.status === 'failed' ? (
                    <X size={11} className="text-danger" aria-hidden />
                  ) : (
                    <Zap size={11} aria-hidden />
                  )}
                  {t('settings.providers.embedding.test')}
                </button>
                <Switch
                  checked={row.enabled}
                  label={t('settings.providers.table.enable', { name: row.displayName || row.modelId })}
                  onChange={(enabled) => set(row.key, { enabled })}
                />
                <RemoveRowButton
                  name={row.displayName || row.modelId}
                  onRemove={() => setRows((all) => all.filter((r) => r.key !== row.key))}
                />
              </div>
              {test?.status === 'ok' && (
                <p role="status" className="mt-1 text-xs text-success">
                  {t('settings.providers.embedding.works', { dims: dims(test.dimensions) })}
                </p>
              )}
              {test?.status === 'failed' && (
                <Tooltip content={test.error} maxWidth={420}>
                  <p role="alert" className="mt-1 w-fit text-xs text-danger">
                    {t(`settings.providers.embedding.errors.${test.code}`)}
                  </p>
                </Tooltip>
              )}
            </div>
          )
        })
      )}
    </div>
  )
}
