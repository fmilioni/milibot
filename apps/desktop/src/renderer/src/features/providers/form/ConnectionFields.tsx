import {
  OutputCapField as OutputCapFieldEnum,
  type Provider,
  ReasoningParam as ReasoningParamEnum,
  ReasoningReplay as ReasoningReplayEnum,
} from '@milibot/shared'
import { useTranslation } from 'react-i18next'

import type { ProviderDraftFields, ProviderDraftState } from '@/features/providers/lib/provider-draft'
import { COMPACT_INPUT } from '@/features/settings/SettingsLayout'
import { cn } from '@/lib/cn'
import { Select } from '@/ui/Select'

/** Name, URL, key, extra headers and, for OpenAI-compatible servers, how requests are shaped. */
export function ConnectionFields({
  provider,
  state,
  urlValid,
  set,
}: {
  provider: Provider | undefined
  state: ProviderDraftState
  urlValid: boolean
  set: (patch: Partial<ProviderDraftFields>) => void
}) {
  const { t } = useTranslation()
  const { type, baseUrl } = state
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)] gap-x-3 gap-y-2.5">
      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium text-fg-secondary">{t('settings.providers.form.name')}</span>
        <input
          className={COMPACT_INPUT}
          value={state.name}
          placeholder={t('settings.providers.form.namePlaceholder')}
          onChange={(e) => set({ name: e.target.value })}
        />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium text-fg-secondary">
          {type === 'anthropic' ? t('settings.providers.form.urlOptional') : t('settings.providers.form.url')}
        </span>
        <input
          className={cn(COMPACT_INPUT, 'font-mono', baseUrl && !urlValid && 'border-danger-soft')}
          value={baseUrl}
          spellCheck={false}
          placeholder={type === 'anthropic' ? 'https://api.anthropic.com' : 'http://192.168.0.20:1234/v1'}
          onChange={(e) => set({ baseUrl: e.target.value })}
        />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium text-fg-secondary">{t('settings.providers.form.key')}</span>
        <input
          className={`${COMPACT_INPUT} font-mono`}
          type="password"
          autoComplete="off"
          value={state.apiKey}
          placeholder={
            provider?.hasSecret
              ? t('settings.providers.form.keySaved')
              : t('settings.providers.form.optional')
          }
          onChange={(e) => set({ apiKey: e.target.value })}
        />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium text-fg-secondary">{t('settings.providers.form.headers')}</span>
        <input
          className={`${COMPACT_INPUT} font-mono`}
          value={state.headers}
          spellCheck={false}
          placeholder={t('settings.providers.form.headersPlaceholder')}
          onChange={(e) => set({ headers: e.target.value })}
        />
      </label>
      {type === 'openai_compatible' && (
        <>
          <div className="flex flex-col gap-1">
            <span className="text-xs font-medium text-fg-secondary">
              {t('settings.providers.form.reasoningParam')}
            </span>
            <Select
              size="sm"
              label={t('settings.providers.form.reasoningParam')}
              value={state.reasoningParam}
              options={ReasoningParamEnum.options.map((value) => ({
                value,
                label: t(`settings.providers.form.reasoningParams.${value}`),
              }))}
              onChange={(reasoningParam) => set({ reasoningParam })}
            />
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-xs font-medium text-fg-secondary">
              {t('settings.providers.form.outputCapField')}
            </span>
            <Select
              size="sm"
              label={t('settings.providers.form.outputCapField')}
              value={state.outputCapField}
              options={OutputCapFieldEnum.options.map((value) => ({
                value,
                label: t(`settings.providers.form.outputCapFields.${value}`),
              }))}
              onChange={(outputCapField) => set({ outputCapField })}
            />
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-xs font-medium text-fg-secondary">
              {t('settings.providers.form.reasoningReplay')}
            </span>
            <Select
              size="sm"
              label={t('settings.providers.form.reasoningReplay')}
              value={state.reasoningReplay}
              options={ReasoningReplayEnum.options.map((value) => ({
                value,
                label: t(`settings.providers.form.reasoningReplays.${value}`),
              }))}
              onChange={(reasoningReplay) => set({ reasoningReplay })}
            />
          </div>
        </>
      )}
    </div>
  )
}
