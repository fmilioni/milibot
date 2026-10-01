import type { ResolvedModel } from '@milibot/agent'
import {
  ANTHROPIC_PRICES,
  anthropicModelInfo,
  DEFAULT_ANTHROPIC_MODEL,
  type LLMProvider,
} from '@milibot/agent/llm'
import {
  type Bot,
  type CliEngine,
  isCliEngine,
  type ModelChoice,
  type ModelTuning,
  pickEffort,
  type Provider,
  type ReasoningEffort,
} from '@milibot/shared'

import { cliEngineHost } from './cli-engines'
import type { ProviderClients } from './clients'
import type { ProviderRow, ProviderStore } from './store'

/** The window a lane works with: the model's registered window capped by the choice's limit. */
export function effectiveContextWindow(
  registered: number | null | undefined,
  limit: number | null | undefined,
): number | null {
  if (registered && limit) return Math.min(registered, limit)
  return registered ?? limit ?? null
}

export interface CatalogModel {
  modelId: string
  displayName: string
  contextWindow: number | null
  efforts: ReasoningEffort[] | null
}

export interface CatalogProvider {
  provider: Pick<Provider, 'id' | 'type' | 'name' | 'preset'>
  models: CatalogModel[]
}

export interface ModelCatalogDeps {
  store: ProviderStore
  clients: ProviderClients
}

/** Which provider and model a turn runs on, and the chat models bots can name. */
export class ModelCatalog {
  constructor(private readonly deps: ModelCatalogDeps) {}

  async resolve(bot: Bot): Promise<ResolvedModel> {
    const fake = this.deps.clients.fakeProvider()
    if (fake) return fakeResolved(fake, bot.model, bot)
    return this.resolveRow(this.deps.store.rowOrDefault(bot.providerId), bot.model, bot)
  }

  /** A specific provider + model (e.g. the workspace's summary model); null model = provider default. */
  async resolveWith(
    providerId: string,
    model: string | null,
    tuning: ModelTuning = {},
  ): Promise<ResolvedModel> {
    const fake = this.deps.clients.fakeProvider()
    if (fake) return fakeResolved(fake, model, tuning)
    return this.resolveRow(this.deps.store.findRow(providerId), model, tuning)
  }

  resolveChoice(choice: ModelChoice): Promise<ResolvedModel> {
    return this.resolveWith(choice.providerId, choice.model, choice)
  }

  /**
   * Every provider with the chat models a turn can run on (enabled registered models; Claude Code's aliases;
   * Anthropic's built-in catalog while none is registered), the bot's provider first.
   */
  catalog(bot: Bot | null): CatalogProvider[] {
    const rows = this.deps.store.rows()
    const first = bot?.providerId ?? rows[0]?.id
    rows.sort((a, b) => Number(b.id === first) - Number(a.id === first))
    return rows.map((row) => {
      const provider = { id: row.id, type: row.type, name: row.name, preset: row.preset }
      const host = cliEngineHost(row.type)
      if (host)
        return {
          provider,
          models: host.models.map((m) => ({
            modelId: m.id,
            displayName: m.displayName,
            contextWindow: m.contextWindow,
            efforts: [...m.efforts],
          })),
        }
      const registered = this.deps.store
        .listModels(row.id)
        .filter((m) => m.enabled)
        .map((m) => ({
          modelId: m.modelId,
          displayName: m.displayName,
          contextWindow: m.contextWindow,
          efforts: m.efforts,
        }))
      if (registered.length || row.type !== 'anthropic') return { provider, models: registered }
      return {
        provider,
        models: Object.entries(ANTHROPIC_PRICES).map(([modelId, info]) => ({
          modelId,
          displayName: info.displayName,
          contextWindow: info.contextWindow,
          efforts: info.efforts,
        })),
      }
    })
  }

  /** The provider and model the bot's own turns run on (null: no provider or no model to use). */
  currentChoice(bot: Bot): ModelChoice | null {
    const row = this.deps.store.rowOrDefault(bot.providerId)
    const model = row ? (bot.model ?? this.defaultModelFor(row)) : null
    return row && model
      ? {
          providerId: row.id,
          model,
          effort: bot.effort,
          contextLimit: bot.contextLimit,
          maxOutputTokens: bot.maxOutputTokens,
        }
      : null
  }

  /**
   * The CLI engine the bot's turns run in (its shell is the VM user `agent`), as `resolve` would pick; with
   * `choice`, a lane opened on that model instead. Null: the native loop.
   */
  cliEngine(bot: Bot, choice?: ModelChoice | null): CliEngine | null {
    if (this.deps.clients.faked) return null
    const type = this.deps.store.rowOrDefault(choice?.providerId ?? bot.providerId)?.type
    return isCliEngine(type) ? type : null
  }

  /**
   * The provider's light model for simple side work (triage, summaries): Claude Code's cheap alias, else the
   * marked one while it is an enabled chat model (Anthropic's built-in catalog while none is registered).
   */
  lightModel(providerId: string): string | null {
    const row = this.deps.store.findRow(providerId)
    if (!row) return null
    const host = cliEngineHost(row.type)
    if (host) return host.lightModel(row.light_model)
    const light = row.light_model
    if (!light) return null
    const registered = this.deps.store.chatModel(row.id, light)
    if (registered) return registered.enabled ? light : null
    const builtin =
      row.type === 'anthropic' && !this.deps.store.listModels(row.id).length && anthropicModelInfo(light)
    return builtin ? light : null
  }

  /** The light model of the provider `own` runs on; null when it has none. */
  async lightModelFor(own: ResolvedModel): Promise<ResolvedModel | null> {
    if (own.kind === 'unavailable' || !own.providerId) return null
    const model = this.lightModel(own.providerId)
    return model ? this.resolveWith(own.providerId, model) : null
  }

  /** How the settings name a model of this provider (registered name, Claude Code alias, built-in catalog). */
  modelDisplayName(providerId: string, model: string): string {
    const type = this.deps.store.findRow(providerId)?.type
    const host = cliEngineHost(type)
    if (host) return host.models.find((m) => m.id === model)?.displayName ?? model
    return (
      this.deps.store.chatModel(providerId, model)?.displayName ??
      (type === 'anthropic' ? anthropicModelInfo(model)?.displayName : undefined) ??
      model
    )
  }

  private defaultModelFor(row: ProviderRow): string | null {
    const configured = this.deps.store.config(row).defaultModel
    if (configured) return configured
    if (row.type === 'anthropic') return DEFAULT_ANTHROPIC_MODEL
    return cliEngineHost(row.type)?.defaultModel || this.deps.store.firstChatModel(row.id)
  }

  private async resolveRow(
    row: ProviderRow | undefined,
    botModel: string | null,
    tuning: ModelTuning,
  ): Promise<ResolvedModel> {
    if (!row) {
      return {
        kind: 'unavailable',
        code: 'no_provider',
        reason: 'No model provider is configured for this workspace.',
      }
    }
    const model = botModel ?? this.defaultModelFor(row)
    const host = cliEngineHost(row.type)
    if (host) {
      const config = this.deps.store.config(row)
      const mode = config.authMode ?? 'subscription'
      const secret = mode === 'subscription' ? null : await this.deps.store.secret(row.id)
      return {
        kind: 'cli',
        engine: host.engine,
        providerId: row.id,
        model,
        ...host.signIn(mode, secret, row.base_url),
        idleTimeoutMs: (config.idleTimeoutMinutes ?? 15) * 60_000,
        effort: pickEffort(tuning.effort, host.efforts(model)),
        contextLimit: tuning.contextLimit ?? null,
        maxOutputTokens: tuning.maxOutputTokens ?? null,
      }
    }
    if (!model) {
      return {
        kind: 'unavailable',
        code: 'no_model',
        reason: `Choose a model for the provider "${row.name}" (or for this bot).`,
      }
    }
    const registered = this.deps.store.chatModel(row.id, model)
    const known = row.type === 'anthropic' ? anthropicModelInfo(model) : null
    return {
      kind: 'native',
      provider: await this.deps.clients.client(row.id),
      providerId: row.id,
      model,
      contextWindow: effectiveContextWindow(
        registered?.contextWindow ?? known?.contextWindow,
        tuning.contextLimit,
      ),
      effort: tuning.effort ?? registered?.defaultEffort ?? null,
      maxOutputTokens: tuning.maxOutputTokens ?? null,
    }
  }
}

function fakeResolved(fake: LLMProvider, model: string | null, tuning: ModelTuning): ResolvedModel {
  return {
    kind: 'native',
    provider: fake,
    providerId: null,
    model: model ?? 'fake-model',
    contextWindow: tuning.contextLimit ?? null,
    effort: tuning.effort ?? null,
    maxOutputTokens: tuning.maxOutputTokens ?? null,
  }
}
