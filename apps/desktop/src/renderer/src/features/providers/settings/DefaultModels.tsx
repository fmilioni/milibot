import {
  type AutomaticModel,
  type ModelChoice,
  type ReasoningEffort,
  type WorkspacePreferences,
} from '@milibot/shared'
import { Feather, Info } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { queryKeys } from '@/api/queries'
import { useApiQuery } from '@/api/use-api-query'
import { getAutomaticModels, type ProvidersData } from '@/features/providers/api'
import {
  chatModelChoices,
  effortForModel,
  effortOptions,
  MODEL_DEFAULT,
} from '@/features/providers/lib/models'
import { decodeModelChoice, encodeModelChoice } from '@/features/providers/lib/provider-form'
import { Notice, SettingsCard } from '@/features/settings/SettingsLayout'
import { useWorkspacePreferences } from '@/features/settings/store'
import { useWorkspaceId } from '@/features/workspace/use-workspace-id'
import type { SelectOption } from '@/lib/select'
import { Button } from '@/ui/Button'
import { Select } from '@/ui/Select'

import { ImageModelRow } from './ImageModelRow'

export function DefaultModels({
  data,
  onEditProvider,
}: {
  data: ProvidersData
  onEditProvider: (providerId: string) => void
}) {
  const { t } = useTranslation()
  const workspaceId = useWorkspaceId()
  const { prefs, loaded, set } = useWorkspacePreferences(workspaceId)
  const { data: automatic } = useApiQuery(
    queryKeys.automaticModels(workspaceId, encodeModelChoice(prefs.summaryModel)),
    () => getAutomaticModels(workspaceId),
  )

  const automaticOption = (auto: AutomaticModel | null | undefined) => ({
    label: auto
      ? t('settings.providers.defaults.automaticModel', { model: auto.displayName })
      : t('settings.providers.defaults.automatic'),
    hint: auto
      ? t(`settings.providers.defaults.automaticSource.${auto.source}`, { provider: auto.providerName })
      : undefined,
  })

  const options = (emptyLabel: string, emptyHint?: string): SelectOption<string>[] => [
    { value: '', label: emptyLabel, description: emptyHint },
    ...data.providers.flatMap((p) =>
      chatModelChoices(p, data.models[p.id]?.chat ?? []).map((m) => ({
        value: encodeModelChoice({ providerId: p.id, model: m.id }),
        label: `${p.name} · ${m.displayName}`,
        group: p.name,
      })),
    ),
  ]

  const modelInfo = (choice: ModelChoice | null) => {
    if (!choice) return null
    const provider = data.providers.find((p) => p.id === choice.providerId)
    const id = choice.model ?? provider?.defaultModel ?? null
    if (!provider || !id) return null
    return chatModelChoices(provider, data.models[provider.id]?.chat ?? []).find((m) => m.id === id) ?? null
  }

  const rows: Array<{
    key: keyof Pick<
      WorkspacePreferences,
      'newBotModel' | 'triageModel' | 'summaryModel' | 'knowledgeSummaryModel' | 'fallbackModel'
    >
    empty: { label: string; hint?: string | undefined }
  }> = [
    { key: 'newBotModel', empty: { label: t('settings.providers.defaults.providerDefault') } },
    { key: 'triageModel', empty: automaticOption(automatic?.triageModel) },
    { key: 'summaryModel', empty: automaticOption(automatic?.summaryModel) },
    { key: 'knowledgeSummaryModel', empty: automaticOption(automatic?.knowledgeSummaryModel) },
    { key: 'fallbackModel', empty: { label: t('settings.providers.defaults.none') } },
  ]

  // Side work left on automatic that runs on the bot's own (full-price) model.
  const onBotModel = (['triageModel', 'summaryModel', 'knowledgeSummaryModel'] as const)
    .filter((key) => !prefs[key])
    .map((key) => automatic?.[key])
    .find((auto) => auto?.source === 'bot')

  return (
    <SettingsCard
      title={<span className="text-md font-semibold text-fg">{t('settings.providers.defaults.title')}</span>}
    >
      <div className="flex flex-col gap-3.5 px-4 pt-1.5 pb-4">
        {onBotModel && (
          <Notice
            icon={<Feather size={13} />}
            tone="warning"
            action={
              <Button size="sm" variant="outline" onClick={() => onEditProvider(onBotModel.providerId)}>
                {t('settings.providers.defaults.markLight')}
              </Button>
            }
          >
            {t('settings.providers.defaults.noLightModel', {
              model: onBotModel.displayName,
              provider: onBotModel.providerName,
            })}
          </Notice>
        )}
        {rows.map(({ key, empty }) => {
          const value = encodeModelChoice(prefs[key])
          const opts = options(empty.label, empty.hint)
          if (value && !opts.some((o) => o.value === value)) {
            const choice = decodeModelChoice(value)
            opts.push({
              value,
              label: `${choice?.model ?? ''}`,
              group: t('settings.providers.defaults.unavailable'),
            })
          }
          const current = prefs[key]
          const info = modelInfo(current)
          const efforts = current ? effortOptions(t, info) : []
          return (
            <div key={key} className="flex flex-col gap-1">
              <span className="text-base font-medium text-fg">{t(`settings.providers.defaults.${key}`)}</span>
              <div className="flex items-center gap-1.5">
                <div className="min-w-0 flex-1">
                  <Select
                    label={t(`settings.providers.defaults.${key}`)}
                    value={value}
                    options={opts}
                    disabled={!loaded}
                    size="sm"
                    onChange={(next) => {
                      const choice = decodeModelChoice(next)
                      void set({
                        [key]: choice && {
                          ...choice,
                          effort: effortForModel(current?.effort ?? null, modelInfo(choice)),
                        },
                      })
                    }}
                  />
                </div>
                <div className="w-[96px] shrink-0">
                  <Select
                    label={`${t('settings.providers.defaults.effort')} · ${t(`settings.providers.defaults.${key}`)}`}
                    value={efforts.length ? (current?.effort ?? MODEL_DEFAULT) : MODEL_DEFAULT}
                    options={
                      efforts.length
                        ? efforts
                        : [{ value: MODEL_DEFAULT, label: t('settings.providers.defaults.effort') }]
                    }
                    disabled={!loaded || !efforts.length}
                    size="sm"
                    menuWidth={200}
                    menuAlign="end"
                    onChange={(effort) =>
                      current &&
                      void set({
                        [key]: {
                          ...current,
                          effort: effort === MODEL_DEFAULT ? null : (effort as ReasoningEffort),
                        },
                      })
                    }
                  />
                </div>
              </div>
              <span className="text-xs text-fg-muted">{t(`settings.providers.defaults.${key}Hint`)}</span>
            </div>
          )
        })}
        <ImageModelRow
          data={data}
          value={prefs.imageModel}
          disabled={!loaded}
          onChange={(imageModel) => void set({ imageModel })}
        />
        <Notice icon={<Info size={13} />}>{t('settings.providers.defaults.note')}</Notice>
      </div>
    </SettingsCard>
  )
}
