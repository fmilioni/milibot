import { CLI_ENGINE_INFO, CLI_ENGINES } from '@milibot/shared'
import i18next, { type TFunction } from 'i18next'
import { beforeAll, describe, expect, it } from 'vitest'

import en from '@/i18n/locales/en'
import ptBR from '@/i18n/locales/pt-BR'

import { cliModels, modelFamily, modelOptions, modelsOf, sortEfforts } from './models'

// Portuguese on purpose: asserts pt-BR model descriptions.

describe('sortEfforts', () => {
  it('shows standard levels by rank before custom ones', () => {
    expect(sortEfforts(['turbo', 'max', 'low', 'minimal', 'low'])).toEqual(['low', 'max', 'turbo', 'minimal'])
  })
})

describe('cliModels', () => {
  it("lists each engine's catalog and nothing for API providers", () => {
    for (const engine of CLI_ENGINES)
      expect(cliModels(engine)?.map((m) => m.id)).toEqual(CLI_ENGINE_INFO[engine].models.map((m) => m.id))
    expect(cliModels('codex')?.[0]).not.toHaveProperty('input')
    expect(cliModels('openai_compatible')).toBeNull()
  })
})

describe('modelOptions', () => {
  let t: TFunction
  let tEn: TFunction
  beforeAll(async () => {
    const instance = i18next.createInstance()
    await instance.init({
      lng: 'pt-BR',
      resources: { 'pt-BR': { translation: ptBR }, en: { translation: en } },
      interpolation: { escapeValue: false },
    })
    t = instance.getFixedT('pt-BR')
    tEn = instance.getFixedT('en')
  })

  const claudeCode = modelsOf({ type: 'claude_code', defaultModel: 'sonnet' } as never, [])

  it('describes the Claude families and marks the default', () => {
    expect(modelOptions(t, claudeCode, 'sonnet')).toEqual([
      { value: 'fable', label: 'Fable', description: 'o mais capaz · o mais caro' },
      { value: 'opus', label: 'Opus', description: 'mais capaz · mais caro' },
      { value: 'sonnet', label: 'Sonnet', description: 'padrão · equilíbrio entre custo e qualidade' },
      { value: 'haiku', label: 'Haiku', description: 'rápido e barato' },
    ])
    expect(modelOptions(tEn, claudeCode, null)[3]).toEqual({
      value: 'haiku',
      label: 'Haiku',
      description: 'fast and cheap',
    })
  })

  it('keeps an unknown current model visible and leaves other models undescribed', () => {
    const saved = (modelId: string, displayName: string, enabled = true) =>
      ({ modelId, displayName, enabled, contextWindow: null, efforts: null, defaultEffort: null }) as never
    const other = modelsOf({ type: 'openai_compatible', defaultModel: null } as never, [
      saved('openai/gpt-5', 'GPT-5'),
      saved('off/model', 'Off', false),
      saved('anthropic/claude-haiku-4.5', 'Claude Haiku 4.5'),
    ])
    expect(modelOptions(t, other, 'retired-model')).toEqual([
      { value: 'openai/gpt-5', label: 'GPT-5', description: 'padrão' },
      { value: 'anthropic/claude-haiku-4.5', label: 'Claude Haiku 4.5', description: 'rápido e barato' },
      { value: 'retired-model', label: 'retired-model', description: undefined },
    ])
    expect(modelFamily('claude-opus-4-1')).toBe('opus')
    expect(modelFamily('gpt-5')).toBeNull()
  })
})
