import { CircleHelp } from 'lucide-react'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

import type { ModelRow } from '@/features/providers/lib/provider-form'
import { COMPACT_INPUT } from '@/features/settings/SettingsLayout'
import { cn } from '@/lib/cn'
import { Checkbox } from '@/ui/Checkbox'
import { Tooltip } from '@/ui/Tooltip'

import { EffortsField } from '../EffortsField'
import { PriceInput, TokenInput } from './cells'

function FieldGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <fieldset className="flex min-w-0 flex-col gap-1.5">
      <legend className="mb-1.5 text-xs font-medium text-fg-secondary">{title}</legend>
      <div className="flex flex-wrap gap-2">{children}</div>
    </fieldset>
  )
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex w-[78px] flex-col gap-1">
      <span className="truncate text-xs text-fg-muted">{label}</span>
      {children}
    </div>
  )
}

export function ModelDetails({
  row,
  set,
  light,
  onLightChange,
}: {
  row: ModelRow
  set: (patch: Partial<ModelRow>) => void
  light: boolean
  onLightChange: (light: boolean) => void
}) {
  const { t } = useTranslation()
  const cacheWrite = t('settings.providers.table.cacheWrite')
  const cacheRead = t('settings.providers.table.cacheRead')
  return (
    <div className="flex flex-col gap-3 pt-2.5 pb-1 pl-[22px]">
      <label className="flex max-w-[360px] flex-col gap-1">
        <span className="text-xs font-medium text-fg-secondary">
          {t('settings.providers.table.displayName')}
        </span>
        <input
          aria-label={`${t('settings.providers.table.displayName')} · ${row.modelId}`}
          value={row.displayName}
          placeholder={row.modelId}
          onChange={(e) => set({ displayName: e.target.value })}
          className={`${COMPACT_INPUT} h-[26px]`}
        />
      </label>
      <div className="flex flex-wrap gap-x-4 gap-y-1.5">
        {(
          [
            ['supportsTools', t('settings.providers.table.tools')],
            ['supportsVision', t('settings.providers.table.vision')],
          ] as const
        ).map(([field, label]) => (
          <label key={field} className="flex cursor-pointer items-center gap-2 text-sm text-fg">
            <Checkbox checked={row[field]} label={label} onChange={(on) => set({ [field]: on })} />
            {label}
          </label>
        ))}
        <span className="flex items-center gap-1.5">
          <label
            className={cn(
              'flex items-center gap-2 text-sm text-fg',
              row.enabled && row.modelId ? 'cursor-pointer' : 'opacity-50',
            )}
          >
            <Checkbox
              checked={light}
              label={t('settings.providers.table.light')}
              disabled={!row.enabled || !row.modelId}
              onChange={onLightChange}
            />
            {t('settings.providers.table.light')}
          </label>
          <Tooltip content={t('settings.providers.table.lightHint')} maxWidth={280}>
            <span
              tabIndex={0}
              role="img"
              aria-label={t('settings.providers.table.lightHint')}
              className="focus-ring flex cursor-help rounded-full text-fg-muted hover:text-fg"
            >
              <CircleHelp size={13} aria-hidden />
            </span>
          </Tooltip>
        </span>
      </div>
      <div className="flex flex-wrap gap-x-7 gap-y-3">
        <FieldGroup title={t('settings.providers.table.groups.limits')}>
          <Field label={t('settings.providers.table.context')}>
            <TokenInput
              label={`${t('settings.providers.table.context')} · ${row.modelId}`}
              hint={t('settings.providers.table.contextHint')}
              value={row.contextWindow}
              disabled={!row.enabled}
              onChange={(contextWindow) => set({ contextWindow })}
            />
          </Field>
          <Field label={t('settings.providers.table.maxOutput')}>
            <TokenInput
              label={`${t('settings.providers.table.maxOutput')} · ${row.modelId}`}
              hint={t('settings.providers.table.maxOutputHint')}
              value={row.maxOutputTokens}
              disabled={!row.enabled}
              onChange={(maxOutputTokens) => set({ maxOutputTokens })}
            />
          </Field>
        </FieldGroup>
        <FieldGroup title={t('settings.providers.table.groups.prices')}>
          {(
            [
              ['priceInputPerMtokUsd', t('settings.providers.table.input')],
              ['priceOutputPerMtokUsd', t('settings.providers.table.output')],
              ['priceCacheWritePerMtokUsd', cacheWrite],
              ['priceCacheReadPerMtokUsd', cacheRead],
            ] as const
          ).map(([field, label]) => (
            <Field key={field} label={label}>
              <PriceInput
                label={`${label} · ${row.modelId}`}
                value={row[field]}
                disabled={!row.enabled}
                onChange={(value) => set({ [field]: value })}
              />
            </Field>
          ))}
        </FieldGroup>
      </div>
      <FieldGroup title={t('settings.providers.table.groups.efforts')}>
        <EffortsField
          efforts={row.efforts}
          defaultEffort={row.defaultEffort}
          modelId={row.modelId}
          disabled={!row.enabled}
          onChange={set}
        />
      </FieldGroup>
    </div>
  )
}
