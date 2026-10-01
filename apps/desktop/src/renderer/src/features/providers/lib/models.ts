import {
  CLI_ENGINE_INFO,
  isCliEngine,
  isStandardEffort,
  type Provider,
  type ProviderModel,
  type ProviderType,
  REASONING_EFFORTS,
  type ReasoningEffort,
} from '@milibot/shared'
import type { TFunction } from 'i18next'

import { tokenInputText } from './provider-form'

/** A model's levels in the order they are shown: standard ones by rank, then custom ones as registered. */
export function sortEfforts(levels: readonly ReasoningEffort[]): ReasoningEffort[] {
  const unique = [...new Set(levels)]
  return [
    ...REASONING_EFFORTS.filter((level) => unique.includes(level)),
    ...unique.filter((l) => !isStandardEffort(l)),
  ]
}

export interface ModelChoice {
  id: string
  displayName: string
  contextWindow?: number | null
  /** Efforts the model accepts; null/absent = unknown. */
  efforts?: readonly ReasoningEffort[] | null
  defaultEffort?: ReasoningEffort | null
}

export interface ProviderModels {
  provider: Provider | null
  models: ModelChoice[]
  /** Model used by bots of this provider that do not pick one. */
  defaultModel: string | null
}

export const EMPTY_MODELS: ProviderModels = { provider: null, models: [], defaultModel: null }

/** The fixed catalog of a CLI engine; null for API providers. */
export function cliModels(type: ProviderType): ModelChoice[] | null {
  if (!isCliEngine(type)) return null
  return CLI_ENGINE_INFO[type].models.map(({ id, displayName, contextWindow, efforts }) => ({
    id,
    displayName,
    contextWindow,
    efforts: [...efforts],
  }))
}

/** The chat models a bot of `provider` can pick: a CLI engine's catalog, or its enabled saved models. */
export function chatModelChoices(
  provider: Pick<Provider, 'type'>,
  saved: readonly ProviderModel[],
): ModelChoice[] {
  return (
    cliModels(provider.type) ??
    saved
      .filter((m) => m.enabled)
      .map((m) => ({
        id: m.modelId,
        displayName: m.displayName,
        contextWindow: m.contextWindow,
        efforts: m.efforts,
        defaultEffort: m.defaultEffort,
      }))
  )
}

/** Models a bot can pick and the one it runs on by default. */
export function modelsOf(provider: Provider | null, saved: readonly ProviderModel[]): ProviderModels {
  if (!provider) return EMPTY_MODELS
  const models = chatModelChoices(provider, saved)
  return { provider, models, defaultModel: provider.defaultModel ?? models[0]?.id ?? null }
}

const MODEL_FAMILIES = ['fable', 'opus', 'sonnet', 'haiku', 'astra', 'sol', 'terra', 'luna'] as const

/**
 * Family of a model id or alias: Claude's (`opus`, `claude-sonnet-4-5`, `anthropic/claude-haiku-4.5`) or
 * GPT's (`gpt-6-astra`, `gpt-6.1-sol`).
 */
export function modelFamily(model: string): (typeof MODEL_FAMILIES)[number] | null {
  const id = model.toLowerCase()
  return MODEL_FAMILIES.find((family) => id.includes(family)) ?? null
}

/**
 * Select options: what each Claude family is good for, the provider default marked in the
 * description, and an unknown current model kept visible.
 */
export function modelOptions(
  t: TFunction,
  { models, defaultModel }: ProviderModels,
  current: string | null,
): Array<{ value: string; label: string; description?: string }> {
  const describe = (id: string) => {
    const family = modelFamily(id)
    const parts = [
      id === defaultModel ? t('models.defaultTag') : null,
      family ? t(`models.descriptions.${family}`) : null,
    ].filter(Boolean)
    return parts.length ? parts.join(' · ') : undefined
  }
  const options = models.map((m) => ({ value: m.id, label: m.displayName, description: describe(m.id) }))
  if (current && !models.some((m) => m.id === current))
    options.push({ value: current, label: current, description: undefined })
  return options
}

/** Value of the "model default" option of the effort, context and output selects. */
export const MODEL_DEFAULT = 'default'

/** Name of an effort level: translated when standard, as registered when it is the server's own. */
export function effortLabel(
  t: TFunction,
  level: ReasoningEffort,
  form: 'levels' | 'short' = 'levels',
): string {
  return isStandardEffort(level) ? t(`reasoningEffort.${form}.${level}`) : level
}

/**
 * Effort select options: the model default first, then the levels the model accepts (every level when
 * unknown). Empty when the model takes no effort.
 */
export function effortOptions(
  t: TFunction,
  model: Pick<ModelChoice, 'efforts' | 'defaultEffort'> | null,
): Array<{ value: string; label: string; description?: string }> {
  const levels = model?.efforts ?? REASONING_EFFORTS
  if (!levels.length) return []
  return [
    {
      value: MODEL_DEFAULT,
      label: t('reasoningEffort.modelDefault'),
      ...(model?.defaultEffort ? { description: effortLabel(t, model.defaultEffort) } : {}),
    },
    ...sortEfforts(levels).map((level) => ({
      value: level,
      label: effortLabel(t, level),
      ...(level === 'low' || level === 'max' ? { description: t(`reasoningEffort.hints.${level}`) } : {}),
    })),
  ]
}

const CONTEXT_STEPS = [1_000_000, 512_000, 256_000, 128_000, 64_000, 32_000]

/** Context select options: the whole window, then common limits below it (and the current one). */
export function contextOptions(
  t: TFunction,
  window: number | null | undefined,
  current: number | null,
): Array<{ value: string; label: string }> {
  const steps = CONTEXT_STEPS.filter((n) => !window || n < window)
  if (current && !steps.includes(current)) steps.push(current)
  return [
    {
      value: MODEL_DEFAULT,
      label: window
        ? t('reasoningEffort.contextFull', { size: tokenInputText(window) })
        : t('reasoningEffort.contextUnlimited'),
    },
    ...steps
      .sort((a, b) => b - a)
      .map((n) => ({
        value: String(n),
        label: t('reasoningEffort.contextTokens', { size: tokenInputText(n) }),
      })),
  ]
}

const OUTPUT_STEPS = [4_000, 8_000, 16_000, 32_000, 64_000, 128_000]

/** Answer limit select options: the model default, then common caps (and the current one). */
export function outputOptions(t: TFunction, current: number | null): Array<{ value: string; label: string }> {
  const steps = current && !OUTPUT_STEPS.includes(current) ? [...OUTPUT_STEPS, current] : OUTPUT_STEPS
  return [
    { value: MODEL_DEFAULT, label: t('reasoningEffort.modelDefault') },
    ...[...steps]
      .sort((a, b) => a - b)
      .map((n) => ({
        value: String(n),
        label: t('reasoningEffort.contextTokens', { size: tokenInputText(n) }),
      })),
  ]
}

/** The bot's effort after a model change: kept when the new model takes it, else back to the default. */
export function effortForModel(
  effort: ReasoningEffort | null,
  model: Pick<ModelChoice, 'efforts'> | null | undefined,
): ReasoningEffort | null {
  return effort && (model?.efforts ?? REASONING_EFFORTS).includes(effort) ? effort : null
}
