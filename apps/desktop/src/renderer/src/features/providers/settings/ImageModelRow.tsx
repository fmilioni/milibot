import { CLI_ENGINE_INFO, type ImageModelChoice, isCliEngine, type Provider } from '@milibot/shared'
import { useTranslation } from 'react-i18next'

import type { ProvidersData } from '@/features/providers/api'
import type { SelectOption } from '@/lib/select'
import { Select } from '@/ui/Select'

/** An engine drawing with its subscription draws only while it signs in that way (the daemon agrees). */
function drawsNow(provider: Provider): boolean {
  if (!isCliEngine(provider.type) || !CLI_ENGINE_INFO[provider.type].subscriptionImages) return true
  return (provider.authMode ?? 'subscription') === 'subscription'
}

export function ImageModelRow({
  data,
  value,
  disabled,
  onChange,
}: {
  data: ProvidersData
  value: ImageModelChoice | null
  disabled: boolean
  onChange: (value: ImageModelChoice | null) => void
}) {
  const { t } = useTranslation()
  const models = data.providers
    .filter(drawsNow)
    .flatMap((p) =>
      (data.models[p.id]?.image ?? []).filter((m) => m.enabled).map((m) => ({ provider: p, model: m })),
    )
  const first = [...models].sort((a, b) => Number(b.provider.isDefault) - Number(a.provider.isDefault))[0]
  const encode = (choice: ImageModelChoice | null) => (choice ? `${choice.providerId}\n${choice.model}` : '')
  const options: SelectOption<string>[] = [
    {
      value: '',
      label: first
        ? t('settings.providers.defaults.automaticModel', { model: first.model.displayName })
        : t('settings.providers.defaults.automatic'),
    },
    ...models.map(({ provider, model }) => ({
      value: encode({ providerId: provider.id, model: model.modelId }),
      label: `${provider.name} · ${model.displayName}`,
      group: provider.name,
    })),
  ]
  const current = encode(value)
  if (current && !options.some((o) => o.value === current))
    options.push({
      value: current,
      label: value?.model ?? '',
      group: t('settings.providers.defaults.unavailable'),
    })
  return (
    <div className="flex flex-col gap-1">
      <span className="text-base font-medium text-fg">{t('settings.providers.defaults.imageModel')}</span>
      <Select
        label={t('settings.providers.defaults.imageModel')}
        value={current}
        options={options}
        disabled={disabled || models.length === 0}
        size="sm"
        onChange={(next) => {
          const [providerId, model] = next.split('\n')
          onChange(providerId && model ? { providerId, model } : null)
        }}
      />
      <span className="text-xs text-fg-muted">
        {models.length === 0
          ? t('settings.providers.defaults.imageModelNone')
          : t('settings.providers.defaults.imageModelHint')}
      </span>
    </div>
  )
}
