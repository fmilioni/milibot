import { readFileSync } from 'node:fs'

import { type ApiEmbeddingOptions, EmbeddingError, findApiEmbeddingModel } from '@milibot/agent/embeddings'
import {
  anthropicPrices,
  AnthropicProvider,
  FakeProvider,
  type FakeStep,
  type LLMProvider,
  type ModelLimits,
  OpenAICompatibleProvider,
  type PriceTable,
} from '@milibot/agent/llm'
import { isCliEngine, OPENROUTER_BASE_URL } from '@milibot/shared'

import { parseJson } from '../../db/sqlite'
import { DaemonError } from '../../errors'
import type { ProviderStore } from './store'

export interface ProviderClientsDeps {
  store: ProviderStore
  /** Path of a JSON array of FakeStep; replaces every provider with a scripted fake (tests, demos). */
  fakeScriptPath?: string | null
  /** Replaces every provider (tests). */
  override?: LLMProvider | null
}

/** The API clients of the providers, or the fake every turn runs on (`MILIBOT_FAKE_LLM`, tests). */
export class ProviderClients {
  private fake: LLMProvider | null

  constructor(private readonly deps: ProviderClientsDeps) {
    this.fake = deps.override ?? null
  }

  /** Whether every provider is replaced by a fake. */
  get faked(): boolean {
    return Boolean(this.deps.override || this.deps.fakeScriptPath)
  }

  /** The scripted fake is read on first use, so the script can be written after the daemon started. */
  fakeProvider(): LLMProvider | null {
    if (!this.fake && this.deps.fakeScriptPath) {
      const script = JSON.parse(readFileSync(this.deps.fakeScriptPath, 'utf8')) as FakeStep[]
      // Priced like Haiku 4.5 so scripted runs show realistic costs.
      this.fake = new FakeProvider({
        id: 'fake',
        script,
        fallback: { text: 'Done.' },
        prices: anthropicPrices('claude-haiku-4-5'),
      })
    }
    return this.fake
  }

  async client(providerId: string): Promise<LLMProvider> {
    const { store } = this.deps
    const row = store.row(providerId)
    if (isCliEngine(row.type))
      throw new DaemonError(
        'validation_failed',
        `${row.name} runs inside the VM and has no direct API client`,
      )
    const secret = await store.secret(providerId)
    switch (row.type) {
      case 'openai_compatible': {
        const config = store.config(row)
        return new OpenAICompatibleProvider({
          id: row.id,
          baseUrl: row.base_url ?? OPENROUTER_BASE_URL,
          apiKey: secret,
          preset: row.preset,
          extraHeaders: parseJson<Record<string, string>>(row.extra_headers, {}),
          reasoningParam: config.reasoningParam ?? 'auto',
          outputCapField: config.outputCapField ?? 'auto',
          reasoningReplay: config.reasoningReplay ?? 'auto',
          prices: this.prices(row.id),
          limits: this.limits(row.id),
        })
      }
      case 'anthropic':
        return new AnthropicProvider({
          id: row.id,
          apiKey: secret,
          baseUrl: row.base_url,
          prices: this.prices(row.id),
          limits: this.limits(row.id),
        })
    }
  }

  /**
   * Connection of an API embedding model (`knowledge.embedding` = `{provider: 'api', …}`), for
   * `createApiEmbeddingProvider`: price, dimensions and longest input as registered in Providers and
   * models (OpenRouter's `usage.cost` still wins). A model that is not registered (or was turned
   * off) is `model_not_registered`: the knowledge base falls back to text search.
   */
  async embeddingApiOptions(providerId: string, model: string): Promise<ApiEmbeddingOptions> {
    const server = await this.deps.store.server(providerId)
    const registered = this.deps.store.embeddingModel(providerId, model)
    if (!registered) {
      throw new EmbeddingError(
        'model_not_registered',
        `The embedding model ${model} is not registered in Providers and models`,
      )
    }
    const known = findApiEmbeddingModel(model)
    return {
      providerId,
      ...server,
      model,
      nativeDimensions: registered.dimensions,
      maxInputTokens: registered.contextWindow ?? known?.maxInputTokens,
      priceInputPerMtokUsd: registered.priceInputPerMtokUsd,
    }
  }

  private prices(providerId: string): (model: string) => PriceTable | null {
    return (model) => {
      const m = this.deps.store.chatModel(providerId, model)
      if (!m) return null
      return {
        priceInputPerMtokUsd: m.priceInputPerMtokUsd,
        priceOutputPerMtokUsd: m.priceOutputPerMtokUsd,
        priceCacheReadPerMtokUsd: m.priceCacheReadPerMtokUsd,
        priceCacheWritePerMtokUsd: m.priceCacheWritePerMtokUsd,
        pricePerRequestUsd: m.pricePerRequestUsd,
      }
    }
  }

  private limits(providerId: string): (model: string) => ModelLimits | null {
    return (model) => {
      const m = this.deps.store.chatModel(providerId, model)
      return m
        ? { contextWindow: m.contextWindow, maxOutputTokens: m.maxOutputTokens, efforts: m.efforts }
        : null
    }
  }
}
