import {
  CLI_ENGINE_INFO,
  type CliEngine,
  type CreateProviderBody,
  type CreateProviderModelBody,
  type DraftModel,
  type EmbeddingModelCandidate,
  type ImageModelCandidate,
  isOpenRouterServer,
  type ModelChoice,
  type Provider,
  type ProviderModel,
} from '@milibot/shared'

/** An OpenRouter provider: created from the preset, or any provider pointed at openrouter.ai. */
export function isOpenRouter(provider: Partial<Pick<Provider, 'preset' | 'baseUrl'>>): boolean {
  return isOpenRouterServer(provider.baseUrl, provider.preset)
}

export function presetForUrl(baseUrl: string): 'openrouter' | 'google' | null {
  if (baseUrl.includes('openrouter.ai')) return 'openrouter'
  if (baseUrl.includes('generativelanguage.googleapis.com')) return 'google'
  return null
}

/** What the app sends to add a CLI engine (subscription login in the VM), from the setup and the providers page. */
export function cliProviderBody(engine: CliEngine): CreateProviderBody {
  const info = CLI_ENGINE_INFO[engine]
  return { type: engine, name: info.displayName, authMode: 'subscription', defaultModel: info.defaultModel }
}

/** One row of the models table of the provider form (saved or not). */
export interface ModelRow extends DraftModel {
  key: string
  enabled: boolean
  /** Saved row id (edit mode). */
  id: string | null
  /** Added with "Add manually": the id is still editable. */
  manual: boolean
}

const SEP = '\u0000'

/** Select value of a default-model choice (model ids may contain `:` or `/`); '' for none. */
export function encodeModelChoice(choice: ModelChoice | null): string {
  return choice ? `${choice.providerId}${SEP}${choice.model ?? ''}` : ''
}

export function decodeModelChoice(value: string): ModelChoice | null {
  if (!value) return null
  const [providerId = '', model = ''] = value.split(SEP)
  return { providerId, model: model || null }
}

let nextKey = 1
const rowKey = () => `row-${nextKey++}`

export function rowFromModel(m: ProviderModel): ModelRow {
  return {
    key: rowKey(),
    id: m.id,
    manual: m.source === 'manual',
    modelId: m.modelId,
    displayName: m.displayName,
    supportsTools: m.supportsTools,
    supportsVision: m.supportsVision,
    contextWindow: m.contextWindow,
    maxOutputTokens: m.maxOutputTokens,
    efforts: m.efforts,
    defaultEffort: m.defaultEffort,
    priceInputPerMtokUsd: m.priceInputPerMtokUsd,
    priceOutputPerMtokUsd: m.priceOutputPerMtokUsd,
    priceCacheWritePerMtokUsd: m.priceCacheWritePerMtokUsd,
    priceCacheReadPerMtokUsd: m.priceCacheReadPerMtokUsd,
    enabled: m.enabled,
  }
}

export function blankRow(): ModelRow {
  return {
    key: rowKey(),
    id: null,
    manual: true,
    modelId: '',
    displayName: '',
    supportsTools: true,
    supportsVision: false,
    contextWindow: null,
    maxOutputTokens: null,
    efforts: null,
    defaultEffort: null,
    priceInputPerMtokUsd: null,
    priceOutputPerMtokUsd: null,
    priceCacheWritePerMtokUsd: null,
    priceCacheReadPerMtokUsd: null,
    enabled: true,
  }
}

/**
 * "Fetch models from the server": server models replace the capabilities, context, output cap and
 * prices the server knows (a value the server doesn't report keeps the one typed in); the name, the switch
 * and manual rows are kept. New models arrive enabled only when the table was empty.
 */
export function mergeFetched(rows: ModelRow[], fetched: DraftModel[]): ModelRow[] {
  const byId = new Map(rows.map((r) => [r.modelId, r]))
  const enableNew = rows.length === 0
  const merged = fetched.map((f): ModelRow => {
    const existing = byId.get(f.modelId)
    const keep = <K extends keyof DraftModel>(k: K) => (f[k] ?? existing?.[k] ?? null) as DraftModel[K]
    return {
      key: existing?.key ?? rowKey(),
      id: existing?.id ?? null,
      manual: false,
      modelId: f.modelId,
      displayName: existing?.displayName || f.displayName || f.modelId,
      supportsTools: f.supportsTools,
      supportsVision: f.supportsVision,
      contextWindow: keep('contextWindow'),
      maxOutputTokens: keep('maxOutputTokens'),
      efforts: keep('efforts'),
      defaultEffort: existing?.defaultEffort ?? f.defaultEffort ?? null,
      priceInputPerMtokUsd: keep('priceInputPerMtokUsd'),
      priceOutputPerMtokUsd: keep('priceOutputPerMtokUsd'),
      priceCacheWritePerMtokUsd: keep('priceCacheWritePerMtokUsd'),
      priceCacheReadPerMtokUsd: keep('priceCacheReadPerMtokUsd'),
      enabled: existing?.enabled ?? enableNew,
    }
  })
  const fetchedIds = new Set(fetched.map((f) => f.modelId))
  return [...merged, ...rows.filter((r) => !fetchedIds.has(r.modelId))]
}

const HAIKU = { anthropic: 'claude-haiku-4-5', openrouter: 'anthropic/claude-haiku-4.5' }

/**
 * The light model a provider starts with: Haiku on Anthropic (built-in catalog, no table) and on OpenRouter
 * while it is listed and on; other servers start with none.
 */
export function suggestedLightModel(
  type: 'openai_compatible' | 'anthropic',
  openRouter: boolean,
  rows: ModelRow[],
) {
  if (type === 'anthropic') return HAIKU.anthropic
  return openRouter && rows.some((r) => r.enabled && r.modelId === HAIKU.openrouter) ? HAIKU.openrouter : null
}

/** The marked light model while its row is on (a model turned off or removed is no longer light). */
export function activeLightModel(rows: ModelRow[], lightModel: string | null): string | null {
  return lightModel && rows.some((r) => r.enabled && r.modelId === lightModel) ? lightModel : null
}

/** `Name: value` per line (or separated by `;`). */
export function parseHeaders(text: string): Record<string, string> {
  const headers: Record<string, string> = {}
  for (const part of text.split(/[\n;]/)) {
    const i = part.indexOf(':')
    if (i <= 0) continue
    const name = part.slice(0, i).trim()
    const value = part.slice(i + 1).trim()
    if (name) headers[name] = value
  }
  return headers
}

export function formatHeaders(headers: Record<string, string>): string {
  return Object.entries(headers)
    .map(([k, v]) => `${k}: ${v}`)
    .join('; ')
}

export interface ModelChanges {
  create: ModelRow[]
  update: ModelRow[]
  remove: string[]
}

const FIELDS = [
  'modelId',
  'displayName',
  'supportsTools',
  'supportsVision',
  'contextWindow',
  'maxOutputTokens',
  'defaultEffort',
  'priceInputPerMtokUsd',
  'priceOutputPerMtokUsd',
  'priceCacheWritePerMtokUsd',
  'priceCacheReadPerMtokUsd',
  'enabled',
] as const

const sameEfforts = (a: readonly string[] | null, b: readonly string[] | null) =>
  a === b || (!!a && !!b && a.length === b.length && a.every((level) => b.includes(level)))

/** What "Save" sends: new rows, changed rows and removed saved rows (rows without an id are ignored). */
export function diffModels(saved: ProviderModel[], rows: ModelRow[]): ModelChanges {
  const valid = rows.filter((r) => r.modelId.trim())
  const savedById = new Map(saved.map((m) => [m.id, m]))
  const keptIds = new Set(valid.flatMap((r) => (r.id ? [r.id] : [])))
  return {
    create: valid.filter((r) => !r.id),
    update: valid.filter((r) => {
      const before = r.id ? savedById.get(r.id) : undefined
      return (
        before !== undefined &&
        (FIELDS.some((f) => before[f] !== r[f]) || !sameEfforts(before.efforts, r.efforts))
      )
    }),
    remove: saved.filter((m) => !keptIds.has(m.id)).map((m) => m.id),
  }
}

/** Price input text → US$ per 1M tokens (comma or dot decimals); empty = unknown. */
export function parsePrice(text: string): number | null {
  const cleaned = text.replace(/[^\d,.]/g, '').replace(',', '.')
  if (!cleaned) return null
  const value = Number(cleaned)
  return Number.isFinite(value) && value >= 0 ? value : null
}

/** What "Save" sends for a chat model row. */
export function chatModelBody(row: ModelRow): CreateProviderModelBody {
  return {
    kind: 'chat',
    modelId: row.modelId.trim(),
    displayName: row.displayName.trim() || row.modelId.trim(),
    supportsTools: row.supportsTools,
    supportsVision: row.supportsVision,
    contextWindow: row.contextWindow,
    maxOutputTokens: row.maxOutputTokens,
    efforts: row.efforts,
    defaultEffort: row.defaultEffort,
    priceInputPerMtokUsd: row.priceInputPerMtokUsd,
    priceOutputPerMtokUsd: row.priceOutputPerMtokUsd,
    priceCacheWritePerMtokUsd: row.priceCacheWritePerMtokUsd,
    priceCacheReadPerMtokUsd: row.priceCacheReadPerMtokUsd,
    enabled: row.enabled,
  }
}

/** One row of the "Search models" table. */
export interface EmbeddingRow {
  key: string
  id: string | null
  manual: boolean
  modelId: string
  displayName: string
  /** Longest input in tokens. */
  contextWindow: number | null
  priceInputPerMtokUsd: number | null
  /** Measured by "Test" (never typed or guessed). */
  dimensions: number | null
  enabled: boolean
}

export function embeddingRowFromModel(m: ProviderModel): EmbeddingRow {
  return {
    key: rowKey(),
    id: m.id,
    manual: m.source === 'manual',
    modelId: m.modelId,
    displayName: m.displayName,
    contextWindow: m.contextWindow,
    priceInputPerMtokUsd: m.priceInputPerMtokUsd,
    dimensions: m.dimensions,
    enabled: m.enabled,
  }
}

export function blankEmbeddingRow(): EmbeddingRow {
  return {
    key: rowKey(),
    id: null,
    manual: true,
    modelId: '',
    displayName: '',
    contextWindow: null,
    priceInputPerMtokUsd: null,
    dimensions: null,
    enabled: true,
  }
}

/** Models ticked when the server list opens: what is already there, else the suggested or likely ones. */
export function initialPicks(
  candidates: EmbeddingModelCandidate[],
  rows: EmbeddingRow[],
  verified: boolean,
): Set<string> {
  const registered = new Set(rows.map((r) => r.modelId))
  return new Set(
    candidates
      .filter((c) => registered.has(c.modelId) || (verified ? c.suggested : c.embedding))
      .map((c) => c.modelId),
  )
}

/**
 * Adds the picked server models to the table: new ones enabled; ones already there get the server's
 * name, context and price (a value the server doesn't report keeps the one typed in).
 */
export function mergeEmbeddingCandidates(
  rows: EmbeddingRow[],
  picked: EmbeddingModelCandidate[],
): EmbeddingRow[] {
  const byId = new Map(picked.map((c) => [c.modelId, c]))
  const updated = rows.map((row): EmbeddingRow => {
    const c = byId.get(row.modelId)
    if (!c) return row
    return {
      ...row,
      displayName: c.displayName || row.displayName,
      contextWindow: c.contextWindow ?? row.contextWindow,
      priceInputPerMtokUsd: c.priceInputPerMtokUsd ?? row.priceInputPerMtokUsd,
      dimensions: c.dimensions ?? row.dimensions,
    }
  })
  const present = new Set(rows.map((r) => r.modelId))
  const added = picked
    .filter((c) => !present.has(c.modelId))
    .map((c): EmbeddingRow => ({
      key: rowKey(),
      id: null,
      manual: false,
      modelId: c.modelId,
      displayName: c.displayName || c.modelId,
      contextWindow: c.contextWindow,
      priceInputPerMtokUsd: c.priceInputPerMtokUsd,
      dimensions: c.dimensions,
      enabled: true,
    }))
  return [...updated, ...added]
}

const EMBEDDING_FIELDS = [
  'modelId',
  'displayName',
  'contextWindow',
  'priceInputPerMtokUsd',
  'dimensions',
  'enabled',
] as const

export interface EmbeddingChanges {
  create: EmbeddingRow[]
  update: EmbeddingRow[]
  remove: string[]
}

export function diffEmbeddingModels(saved: ProviderModel[], rows: EmbeddingRow[]): EmbeddingChanges {
  const valid = rows.filter((r) => r.modelId.trim())
  const savedById = new Map(saved.map((m) => [m.id, m]))
  const keptIds = new Set(valid.flatMap((r) => (r.id ? [r.id] : [])))
  return {
    create: valid.filter((r) => !r.id),
    update: valid.filter((r) => {
      const before = r.id ? savedById.get(r.id) : undefined
      return before !== undefined && EMBEDDING_FIELDS.some((f) => before[f] !== r[f])
    }),
    remove: saved.filter((m) => !keptIds.has(m.id)).map((m) => m.id),
  }
}

export function embeddingModelBody(row: EmbeddingRow): CreateProviderModelBody {
  return {
    kind: 'embedding',
    modelId: row.modelId.trim(),
    displayName: row.displayName.trim() || row.modelId.trim(),
    supportsTools: false,
    supportsVision: false,
    contextWindow: row.contextWindow,
    priceInputPerMtokUsd: row.priceInputPerMtokUsd,
    dimensions: row.dimensions,
    enabled: row.enabled,
  }
}

export interface ImageRow {
  key: string
  id: string | null
  manual: boolean
  modelId: string
  displayName: string
  pricePerImageUsd: number | null
  /** Takes reference images (edits a photo the user sent). */
  supportsVision: boolean
  enabled: boolean
}

export function imageRowFromModel(m: ProviderModel): ImageRow {
  return {
    key: rowKey(),
    id: m.id,
    manual: m.source === 'manual',
    modelId: m.modelId,
    displayName: m.displayName,
    pricePerImageUsd: m.pricePerRequestUsd,
    supportsVision: m.supportsVision,
    enabled: m.enabled,
  }
}

export function blankImageRow(): ImageRow {
  return {
    key: rowKey(),
    id: null,
    manual: true,
    modelId: '',
    displayName: '',
    pricePerImageUsd: null,
    supportsVision: false,
    enabled: true,
  }
}

export function initialImagePicks(candidates: ImageModelCandidate[], rows: ImageRow[]): Set<string> {
  const registered = new Set(rows.map((r) => r.modelId))
  return new Set(candidates.filter((c) => registered.has(c.modelId)).map((c) => c.modelId))
}

/** Adds the picked server models; ones already there get the server's name and a price it knows. */
export function mergeImageCandidates(rows: ImageRow[], picked: ImageModelCandidate[]): ImageRow[] {
  const byId = new Map(picked.map((c) => [c.modelId, c]))
  const updated = rows.map((row): ImageRow => {
    const c = byId.get(row.modelId)
    if (!c) return row
    return {
      ...row,
      displayName: c.displayName || row.displayName,
      pricePerImageUsd: row.pricePerImageUsd ?? c.pricePerImageUsd,
      supportsVision: c.supportsVision,
    }
  })
  const present = new Set(rows.map((r) => r.modelId))
  const added = picked
    .filter((c) => !present.has(c.modelId))
    .map((c): ImageRow => ({
      key: rowKey(),
      id: null,
      manual: false,
      modelId: c.modelId,
      displayName: c.displayName || c.modelId,
      pricePerImageUsd: c.pricePerImageUsd,
      supportsVision: c.supportsVision,
      enabled: true,
    }))
  return [...updated, ...added]
}

export interface ImageChanges {
  create: ImageRow[]
  update: ImageRow[]
  remove: string[]
}

export function diffImageModels(saved: ProviderModel[], rows: ImageRow[]): ImageChanges {
  const valid = rows.filter((r) => r.modelId.trim())
  const savedById = new Map(saved.map((m) => [m.id, m]))
  const keptIds = new Set(valid.flatMap((r) => (r.id ? [r.id] : [])))
  return {
    create: valid.filter((r) => !r.id),
    update: valid.filter((r) => {
      const before = r.id ? savedById.get(r.id) : undefined
      return (
        before !== undefined &&
        (before.modelId !== r.modelId ||
          before.displayName !== r.displayName ||
          before.pricePerRequestUsd !== r.pricePerImageUsd ||
          before.supportsVision !== r.supportsVision ||
          before.enabled !== r.enabled)
      )
    }),
    remove: saved.filter((m) => !keptIds.has(m.id)).map((m) => m.id),
  }
}

export function imageModelBody(row: ImageRow): CreateProviderModelBody {
  return {
    kind: 'image',
    modelId: row.modelId.trim(),
    displayName: row.displayName.trim() || row.modelId.trim(),
    supportsTools: false,
    supportsVision: row.supportsVision,
    pricePerRequestUsd: row.pricePerImageUsd,
    enabled: row.enabled,
  }
}

/** `128k`, `1M`, `131072`, `1.5M`, `32 768` → tokens; empty or invalid = null (unknown). */
export function parseTokens(text: string): number | null {
  const cleaned = text.trim().toLowerCase().replace(/\s+/g, '')
  if (!cleaned) return null
  const match = /^(\d+(?:[.,]\d+)?)(k|m)?$/.exec(cleaned)
  if (!match) {
    const digits = cleaned.replace(/[.,]/g, '')
    return /^\d+$/.test(digits) && Number(digits) > 0 ? Number(digits) : null
  }
  const [, number = '', unit] = match
  if (!unit) {
    const digits = number.replace(/[.,]/g, '')
    return Number(digits) > 0 ? Number(digits) : null
  }
  const value = Math.round(Number(number.replace(',', '.')) * (unit === 'k' ? 1000 : 1_000_000))
  return value > 0 ? value : null
}

/**
 * Compact text for a token input: `128k`, `1M`, `131k` (131072); empty when unknown. Rounded for
 * reading only: the input keeps the exact value unless the text is edited.
 */
export function tokenInputText(tokens: number | null): string {
  if (!tokens) return ''
  if (tokens >= 1_000_000) return `${Number((tokens / 1_000_000).toFixed(tokens % 1_000_000 === 0 ? 0 : 1))}M`
  if (tokens >= 1000) return `${Math.round(tokens / 1000)}k`
  return String(tokens)
}
