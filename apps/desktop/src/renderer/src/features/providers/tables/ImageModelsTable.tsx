import { useTranslation } from 'react-i18next'

import type { ImageRow } from '@/features/providers/lib/provider-form'
import { COMPACT_INPUT } from '@/features/settings/SettingsLayout'
import { cn } from '@/lib/cn'
import { Checkbox } from '@/ui/Checkbox'
import { Switch } from '@/ui/Switch'
import { Tooltip } from '@/ui/Tooltip'

import { patchRow, PriceInput, RemoveRowButton, type SetRows } from './cells'

export function ImageModelsTable({ rows, setRows }: { rows: ImageRow[]; setRows: SetRows<ImageRow> }) {
  const { t } = useTranslation()
  const set = (key: string, patch: Partial<ImageRow>) => patchRow(setRows, key, patch)
  const grid = 'grid grid-cols-[minmax(0,1fr)_92px_80px_36px_22px] items-center gap-x-1.5'
  return (
    <div className="flex flex-col overflow-hidden rounded-[10px] border border-border">
      <div role="row" className={`${grid} bg-surface-3/70 px-3 py-1.5 text-xs font-medium text-fg-secondary`}>
        <span role="columnheader">{t('settings.providers.table.model')}</span>
        <span role="columnheader" className="truncate">
          {t('settings.providers.image.references')}
        </span>
        <span role="columnheader">{t('settings.providers.image.price')}</span>
        <span className="sr-only">{t('settings.providers.table.enabled')}</span>
        <span />
      </div>
      {rows.length === 0 ? (
        <div className="px-3 py-4 text-center text-sm text-fg-muted">
          {t('settings.providers.image.empty')}
        </div>
      ) : (
        rows.map((row) => (
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
                      set(row.key, { modelId: e.target.value.trim(), displayName: e.target.value.trim() })
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
              <Tooltip content={t('settings.providers.image.referencesHint')}>
                <span className="w-fit">
                  <Checkbox
                    checked={row.supportsVision}
                    label={`${t('settings.providers.image.references')} · ${row.modelId}`}
                    onChange={(supportsVision) => set(row.key, { supportsVision })}
                  />
                </span>
              </Tooltip>
              <PriceInput
                label={`${t('settings.providers.image.price')} · ${row.modelId}`}
                value={row.pricePerImageUsd}
                disabled={!row.enabled}
                onChange={(pricePerImageUsd) => set(row.key, { pricePerImageUsd })}
              />
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
          </div>
        ))
      )}
    </div>
  )
}
