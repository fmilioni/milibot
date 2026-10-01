import type { DiscoveredModel } from '@milibot/agent/llm'
import {
  CLI_ENGINES,
  type CreateProviderBody,
  type CreateProviderModelBody,
  type ImageModelChoice,
  isCliEngine,
  newId,
  OPENROUTER_BASE_URL,
  type Provider,
  type ProviderModel,
  type ProviderModelKind,
  type ProviderType,
  ReasoningEffort,
  type UpdateProviderBody,
} from '@milibot/shared'

import { bool, type Db, parseJson } from '../../db/sqlite'
import { DaemonError, notFound } from '../../errors'
import { secretKeyFor, type SecretStore } from '../../secrets/secret-store'
import { CLI_ENGINE_HOSTS, cliEngineHost } from './cli-engines'
import { presetBaseUrl } from './presets'

export interface ProviderRow {
  id: string
  type: ProviderType
  name: string
  preset: string | null
  base_url: string | null
  extra_headers: string
  config: string
  light_model: string | null
  is_default: number
  created_at: number
  updated_at: number
}

export interface ProviderConfigJson {
  defaultModel?: string | null
  authMode?: Provider['authMode']
  idleTimeoutMinutes?: number | null
  reasoningParam?: Provider['reasoningParam']
  outputCapField?: Provider['outputCapField']
  reasoningReplay?: Provider['reasoningReplay']
}

interface ModelRow {
  id: string
  provider_id: string
  kind: ProviderModelKind
  model_id: string
  display_name: string
  supports_tools: number
  supports_vision: number
  context_window: number | null
  max_output_tokens: number | null
  efforts: string | null
  default_effort: ReasoningEffort | null
  dimensions: number | null
  price_input_per_mtok_usd: number | null
  price_cache_read_per_mtok_usd: number | null
  price_cache_write_per_mtok_usd: number | null
  price_output_per_mtok_usd: number | null
  price_per_request_usd: number | null
  enabled: number
  source: ProviderModel['source']
  created_at: number
  updated_at: number
}

function toModel(r: ModelRow): ProviderModel {
  return {
    id: r.id,
    providerId: r.provider_id,
    kind: r.kind,
    modelId: r.model_id,
    displayName: r.display_name,
    supportsTools: r.supports_tools === 1,
    supportsVision: r.supports_vision === 1,
    contextWindow: r.context_window,
    maxOutputTokens: r.max_output_tokens,
    efforts: parseEfforts(r.efforts),
    defaultEffort: r.default_effort,
    dimensions: r.dimensions,
    priceInputPerMtokUsd: r.price_input_per_mtok_usd,
    priceCacheReadPerMtokUsd: r.price_cache_read_per_mtok_usd,
    priceCacheWritePerMtokUsd: r.price_cache_write_per_mtok_usd,
    priceOutputPerMtokUsd: r.price_output_per_mtok_usd,
    pricePerRequestUsd: r.price_per_request_usd,
    enabled: r.enabled === 1,
    source: r.source,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

function parseEfforts(json: string | null): ReasoningEffort[] | null {
  const parsed = ReasoningEffort.array().safeParse(parseJson<unknown>(json, null))
  return parsed.success ? parsed.data : null
}

function effortsJson(efforts: readonly ReasoningEffort[] | null | undefined): string | null {
  return efforts ? JSON.stringify(efforts) : null
}

export interface ProviderStoreDeps {
  db: Db
  workspaceId: string
  secrets: SecretStore
  now?: () => number
}

/** The `providers` and `provider_models` rows, and each provider's secret. */
export class ProviderStore {
  private readonly now: () => number

  constructor(private readonly deps: ProviderStoreDeps) {
    this.now = deps.now ?? Date.now
  }

  private get db(): Db {
    return this.deps.db
  }

  row(id: string): ProviderRow {
    const row = this.findRow(id)
    if (!row) throw notFound('provider', id)
    return row
  }

  findRow(id: string): ProviderRow | undefined {
    return this.db.prepare('SELECT * FROM providers WHERE id = ?').get(id) as ProviderRow | undefined
  }

  /** The given provider, else the default one (the oldest when none is marked). */
  rowOrDefault(id: string | null | undefined): ProviderRow | undefined {
    return (
      (id ? this.findRow(id) : undefined) ??
      (this.db.prepare('SELECT * FROM providers ORDER BY is_default DESC, created_at LIMIT 1').get() as
        ProviderRow | undefined)
    )
  }

  /** Every provider, the default first. */
  rows(): ProviderRow[] {
    return this.db
      .prepare('SELECT * FROM providers ORDER BY is_default DESC, created_at, id')
      .all() as ProviderRow[]
  }

  config(row: ProviderRow): ProviderConfigJson {
    return parseJson<ProviderConfigJson>(row.config, {})
  }

  /** The oldest enabled chat model of a provider. */
  firstChatModel(providerId: string): string | null {
    const first = this.db
      .prepare(
        "SELECT model_id FROM provider_models WHERE provider_id = ? AND kind = 'chat' AND enabled = 1 ORDER BY created_at LIMIT 1",
      )
      .get(providerId) as { model_id: string } | undefined
    return first?.model_id ?? null
  }

  private async toProvider(row: ProviderRow): Promise<Provider> {
    const config = this.config(row)
    return {
      id: row.id,
      type: row.type,
      name: row.name,
      preset: row.preset,
      baseUrl: row.base_url,
      extraHeaders: parseJson<Record<string, string>>(row.extra_headers, {}),
      lightModel: row.light_model,
      isDefault: row.is_default === 1,
      defaultModel: config.defaultModel ?? null,
      hasSecret: (await this.secret(row.id)) !== null,
      authMode: isCliEngine(row.type) ? (config.authMode ?? 'subscription') : null,
      idleTimeoutMinutes: isCliEngine(row.type) ? (config.idleTimeoutMinutes ?? 15) : null,
      reasoningParam: row.type === 'openai_compatible' ? (config.reasoningParam ?? 'auto') : null,
      outputCapField: row.type === 'openai_compatible' ? (config.outputCapField ?? 'auto') : null,
      reasoningReplay: row.type === 'openai_compatible' ? (config.reasoningReplay ?? 'auto') : null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  }

  secret(providerId: string): Promise<string | null> {
    return this.deps.secrets.get(this.deps.workspaceId, secretKeyFor(providerId))
  }

  /** Whether a provider of this type exists (e.g. Codex, which needs its CLI in the VM). */
  hasType(type: ProviderType): boolean {
    return this.db.prepare('SELECT 1 FROM providers WHERE type = ? LIMIT 1').get(type) !== undefined
  }

  hasAny(): boolean {
    return this.db.prepare('SELECT 1 FROM providers LIMIT 1').get() !== undefined
  }

  exists(id: string): boolean {
    return this.db.prepare('SELECT 1 FROM providers WHERE id = ?').get(id) !== undefined
  }

  async list(): Promise<Provider[]> {
    const rows = this.db.prepare('SELECT * FROM providers ORDER BY created_at, id').all() as ProviderRow[]
    return Promise.all(rows.map((r) => this.toProvider(r)))
  }

  get(id: string): Promise<Provider> {
    return this.toProvider(this.row(id))
  }

  private setDefault(id: string): void {
    this.db.transaction(() => {
      this.db.prepare('UPDATE providers SET is_default = 0 WHERE is_default = 1').run()
      this.db.prepare('UPDATE providers SET is_default = 1 WHERE id = ?').run(id)
    })()
  }

  async create(body: CreateProviderBody): Promise<Provider> {
    const id = newId('provider')
    const now = this.now()
    const baseUrl = body.baseUrl ?? presetBaseUrl(body.preset)
    if (body.type === 'openai_compatible' && !baseUrl) {
      throw new DaemonError('validation_failed', 'An OpenAI-compatible provider needs a base URL')
    }
    const config: ProviderConfigJson = {
      defaultModel: body.defaultModel ?? cliEngineHost(body.type)?.defaultModel ?? null,
      ...(isCliEngine(body.type)
        ? { authMode: body.authMode ?? 'subscription', idleTimeoutMinutes: body.idleTimeoutMinutes ?? 15 }
        : {}),
      ...(body.type === 'openai_compatible'
        ? {
            reasoningParam: body.reasoningParam ?? 'auto',
            outputCapField: body.outputCapField ?? 'auto',
            reasoningReplay: body.reasoningReplay ?? 'auto',
          }
        : {}),
    }
    this.db
      .prepare(
        `INSERT INTO providers (id, type, name, preset, base_url, extra_headers, config, light_model, is_default, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
      )
      .run(
        id,
        body.type,
        body.name,
        body.preset ?? null,
        baseUrl,
        JSON.stringify(body.extraHeaders ?? {}),
        JSON.stringify(config),
        body.lightModel ?? null,
        now,
        now,
      )
    if (body.apiKey) await this.deps.secrets.set(this.deps.workspaceId, secretKeyFor(id), body.apiKey)
    const imageModel = cliEngineHost(body.type)?.imageModel
    if (imageModel) this.createModel(id, imageModel)
    const count = (this.db.prepare('SELECT COUNT(*) AS n FROM providers').get() as { n: number }).n
    if (body.isDefault || count === 1) this.setDefault(id)
    return this.get(id)
  }

  async update(id: string, body: UpdateProviderBody): Promise<Provider> {
    const row = this.row(id)
    const config = this.config(row)
    if (body.defaultModel !== undefined) config.defaultModel = body.defaultModel
    if (body.authMode !== undefined) config.authMode = body.authMode
    if (body.idleTimeoutMinutes !== undefined) config.idleTimeoutMinutes = body.idleTimeoutMinutes
    if (row.type === 'openai_compatible') {
      if (body.reasoningParam !== undefined) config.reasoningParam = body.reasoningParam
      if (body.outputCapField !== undefined) config.outputCapField = body.outputCapField
      if (body.reasoningReplay !== undefined) config.reasoningReplay = body.reasoningReplay
    }
    this.db
      .prepare(
        `UPDATE providers SET name = ?, preset = ?, base_url = ?, extra_headers = ?, config = ?, light_model = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        body.name ?? row.name,
        body.preset === undefined ? row.preset : body.preset,
        body.baseUrl === undefined ? row.base_url : body.baseUrl,
        body.extraHeaders === undefined ? row.extra_headers : JSON.stringify(body.extraHeaders),
        JSON.stringify(config),
        body.lightModel === undefined ? row.light_model : body.lightModel,
        this.now(),
        id,
      )
    if (body.apiKey === null) await this.deps.secrets.delete(this.deps.workspaceId, secretKeyFor(id))
    else if (body.apiKey) await this.deps.secrets.set(this.deps.workspaceId, secretKeyFor(id), body.apiKey)
    if (body.isDefault) this.setDefault(id)
    return this.get(id)
  }

  async delete(id: string): Promise<void> {
    const row = this.row(id)
    this.db.prepare('DELETE FROM providers WHERE id = ?').run(id)
    await this.deps.secrets.delete(this.deps.workspaceId, secretKeyFor(id))
    if (row.is_default === 1) {
      const next = this.db.prepare('SELECT id FROM providers ORDER BY created_at LIMIT 1').get() as
        { id: string } | undefined
      if (next) this.setDefault(next.id)
    }
  }

  listModels(providerId: string, kind: ProviderModelKind = 'chat'): ProviderModel[] {
    this.row(providerId)
    const rows = this.db
      .prepare(
        'SELECT * FROM provider_models WHERE provider_id = ? AND kind = ? ORDER BY display_name, model_id',
      )
      .all(providerId, kind) as ModelRow[]
    return rows.map(toModel)
  }

  /** By row id (any kind) or by model id among the models of `kind`. */
  private modelRow(providerId: string, id: string, kind: ProviderModelKind = 'chat'): ModelRow {
    const row = this.db
      .prepare(
        `SELECT * FROM provider_models WHERE provider_id = ? AND (id = ? OR (model_id = ? AND kind = ?))
         ORDER BY id = ? DESC LIMIT 1`,
      )
      .get(providerId, id, id, kind, id) as ModelRow | undefined
    if (!row) throw notFound('model', id)
    return row
  }

  createModel(
    providerId: string,
    body: CreateProviderModelBody,
    source: ProviderModel['source'] = 'manual',
  ): ProviderModel {
    this.row(providerId)
    const now = this.now()
    const id = newId('providerModel')
    const kind = body.kind ?? 'chat'
    this.db
      .prepare(
        `INSERT INTO provider_models (id, provider_id, kind, model_id, display_name, supports_tools, supports_vision,
           context_window, max_output_tokens, efforts, default_effort, dimensions, price_input_per_mtok_usd,
           price_cache_read_per_mtok_usd, price_cache_write_per_mtok_usd, price_output_per_mtok_usd,
           price_per_request_usd, enabled, source, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (provider_id, kind, model_id) DO UPDATE SET supports_tools = excluded.supports_tools, supports_vision = excluded.supports_vision,
           context_window = excluded.context_window, max_output_tokens = excluded.max_output_tokens,
           efforts = coalesce(excluded.efforts, provider_models.efforts),
           default_effort = coalesce(provider_models.default_effort, excluded.default_effort),
           dimensions = coalesce(excluded.dimensions, provider_models.dimensions),
           price_input_per_mtok_usd = excluded.price_input_per_mtok_usd,
           price_cache_read_per_mtok_usd = excluded.price_cache_read_per_mtok_usd,
           price_cache_write_per_mtok_usd = excluded.price_cache_write_per_mtok_usd,
           price_output_per_mtok_usd = excluded.price_output_per_mtok_usd,
           price_per_request_usd = excluded.price_per_request_usd, source = excluded.source, updated_at = excluded.updated_at`,
      )
      .run(
        id,
        providerId,
        kind,
        body.modelId,
        body.displayName ?? body.modelId,
        bool(body.supportsTools ?? kind === 'chat'),
        bool(body.supportsVision ?? kind === 'chat'),
        body.contextWindow ?? null,
        body.maxOutputTokens ?? null,
        effortsJson(body.efforts),
        body.defaultEffort ?? null,
        body.dimensions ?? null,
        body.priceInputPerMtokUsd ?? null,
        body.priceCacheReadPerMtokUsd ?? null,
        body.priceCacheWritePerMtokUsd ?? null,
        body.priceOutputPerMtokUsd ?? null,
        body.pricePerRequestUsd ?? null,
        bool(body.enabled ?? true),
        source,
        now,
        now,
      )
    return toModel(this.modelRow(providerId, body.modelId, kind))
  }

  updateModel(providerId: string, id: string, body: Partial<CreateProviderModelBody>): ProviderModel {
    const current = toModel(this.modelRow(providerId, id))
    const next = {
      ...current,
      ...Object.fromEntries(Object.entries(body).filter(([k, v]) => v !== undefined && k !== 'kind')),
    }
    this.db
      .prepare(
        `UPDATE provider_models SET model_id = ?, display_name = ?, supports_tools = ?, supports_vision = ?, context_window = ?,
           max_output_tokens = ?, efforts = ?, default_effort = ?, dimensions = ?, price_input_per_mtok_usd = ?,
           price_cache_read_per_mtok_usd = ?,
           price_cache_write_per_mtok_usd = ?, price_output_per_mtok_usd = ?, price_per_request_usd = ?, enabled = ?,
           updated_at = ? WHERE id = ?`,
      )
      .run(
        next.modelId,
        next.displayName,
        bool(next.supportsTools),
        bool(next.supportsVision),
        next.contextWindow,
        next.maxOutputTokens,
        effortsJson(next.efforts),
        next.defaultEffort,
        next.dimensions,
        next.priceInputPerMtokUsd,
        next.priceCacheReadPerMtokUsd,
        next.priceCacheWritePerMtokUsd,
        next.priceOutputPerMtokUsd,
        next.pricePerRequestUsd,
        bool(next.enabled),
        this.now(),
        current.id,
      )
    return toModel(this.modelRow(providerId, current.id))
  }

  deleteModel(providerId: string, id: string): void {
    const row = this.modelRow(providerId, id)
    this.db.prepare('DELETE FROM provider_models WHERE id = ?').run(row.id)
  }

  upsertDiscovered(providerId: string, models: DiscoveredModel[]): ProviderModel[] {
    this.db.transaction(() => {
      for (const m of models) this.createModel(providerId, m, m.source)
    })()
    return this.listModels(providerId)
  }

  /** Registers embedding models that are not there yet (keeps what the user edited). */
  addEmbeddingModels(providerId: string, models: CreateProviderModelBody[]): ProviderModel[] {
    const existing = new Set(this.listModels(providerId, 'embedding').map((m) => m.modelId))
    this.db.transaction(() => {
      for (const m of models)
        if (!existing.has(m.modelId)) this.createModel(providerId, { ...m, kind: 'embedding' }, 'fetched')
    })()
    return this.listModels(providerId, 'embedding')
  }

  /** Registers image models that are not there yet (keeps what the user edited). */
  addImageModels(providerId: string, models: CreateProviderModelBody[]): ProviderModel[] {
    const existing = new Set(this.listModels(providerId, 'image').map((m) => m.modelId))
    this.db.transaction(() => {
      for (const m of models)
        if (!existing.has(m.modelId)) this.createModel(providerId, { ...m, kind: 'image' }, 'fetched')
    })()
    return this.listModels(providerId, 'image')
  }

  /**
   * Enabled image models: OpenAI-compatible providers' and those of a CLI engine that draws with its
   * subscription (Codex), only while it signs in that way.
   */
  imageModels(): Array<{ model: ProviderModel; providerName: string; providerType: ProviderType }> {
    const drawing = CLI_ENGINES.filter((engine) => CLI_ENGINE_HOSTS[engine].imageModel)
    const rows = this.db
      .prepare(
        `SELECT m.*, p.name AS provider_name, p.type AS provider_type FROM provider_models m
         JOIN providers p ON p.id = m.provider_id
         WHERE m.kind = 'image' AND m.enabled = 1 AND (p.type = 'openai_compatible' OR (p.type IN (${drawing
           .map(() => '?')
           .join(', ')})
           AND coalesce(json_extract(p.config, '$.authMode'), 'subscription') = 'subscription'))
         ORDER BY p.is_default DESC, p.created_at, m.created_at, m.model_id`,
      )
      .all(...drawing) as Array<ModelRow & { provider_name: string; provider_type: ProviderType }>
    return rows.map((row) => ({
      model: toModel(row),
      providerName: row.provider_name,
      providerType: row.provider_type,
    }))
  }

  /**
   * The image model to draw with: `requested` by id or name when given, else the preference, else the first
   * enabled one. Null when none fits.
   */
  imageModel(
    choice: ImageModelChoice | null,
    requested?: string,
  ): { model: ProviderModel; providerName: string; providerType: ProviderType } | null {
    const models = this.imageModels()
    if (requested) {
      const wanted = requested.trim().toLowerCase()
      return (
        models.find((m) => m.model.modelId.toLowerCase() === wanted) ??
        models.find((m) => m.model.displayName.toLowerCase() === wanted) ??
        models.find((m) => m.model.modelId.toLowerCase().endsWith(`/${wanted}`)) ??
        null
      )
    }
    const chosen = choice
      ? models.find((m) => m.model.providerId === choice.providerId && m.model.modelId === choice.model)
      : undefined
    return chosen ?? models[0] ?? null
  }

  /** Enabled embedding model of the provider, or null. */
  embeddingModel(providerId: string, model: string): ProviderModel | null {
    const row = this.db
      .prepare(
        "SELECT * FROM provider_models WHERE provider_id = ? AND kind = 'embedding' AND model_id = ? AND enabled = 1",
      )
      .get(providerId, model) as ModelRow | undefined
    return row ? toModel(row) : null
  }

  setEmbeddingDimensions(providerId: string, model: string, dimensions: number): void {
    this.db
      .prepare(
        "UPDATE provider_models SET dimensions = ?, updated_at = ? WHERE provider_id = ? AND kind = 'embedding' AND model_id = ?",
      )
      .run(dimensions, this.now(), providerId, model)
  }

  chatModel(providerId: string, model: string): ProviderModel | null {
    const row = this.db
      .prepare("SELECT * FROM provider_models WHERE provider_id = ? AND kind = 'chat' AND model_id = ?")
      .get(providerId, model) as ModelRow | undefined
    return row ? toModel(row) : null
  }

  /** Base URL, key and headers of an OpenAI-compatible provider (embeddings, images, listings and tests). */
  async server(providerId: string): Promise<{
    baseUrl: string
    apiKey: string | null
    preset: string | null
    extraHeaders: Record<string, string>
  }> {
    const row = this.row(providerId)
    if (row.type !== 'openai_compatible') {
      throw new DaemonError('validation_failed', `The provider "${row.name}" is not OpenAI-compatible`)
    }
    return {
      baseUrl: row.base_url ?? OPENROUTER_BASE_URL,
      apiKey: await this.secret(row.id),
      preset: row.preset,
      extraHeaders: parseJson<Record<string, string>>(row.extra_headers, {}),
    }
  }
}
