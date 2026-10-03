import type { ModelRequest, ModelRequestResult } from '@milibot/agent'
import {
  type Bot,
  foldText,
  isStandardEffort,
  MIN_CONTEXT_LIMIT,
  type ModelChoice,
  normalizeEffort,
  pickEffort,
  REASONING_EFFORTS,
} from '@milibot/shared'

import type { CatalogModel, CatalogProvider, ModelCatalog } from './catalog'

const MAX_LISTED = 40

function tokens(text: string): string[] {
  return foldText(text)
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
}

/** Numbers in a model id, in order: `claude-opus-5-5` → [5, 5]. */
function version(id: string): number[] {
  return tokens(id)
    .filter((t) => /^\d+$/.test(t))
    .map(Number)
}

function compareVersions(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const diff = (a[i] ?? -1) - (b[i] ?? -1)
    if (diff !== 0) return diff
  }
  return 0
}

export function parseContextLimit(value: string | number | null | undefined): number | null | 'invalid' {
  if (value === null || value === undefined || value === '') return null
  if (typeof value === 'number') return Number.isInteger(value) && value > 0 ? value : 'invalid'
  const match = /^\s*(\d+(?:[.,]\d+)?)\s*([km])?\s*$/i.exec(value)
  if (!match) return 'invalid'
  const n = Number((match[1] as string).replace(',', '.'))
  const unit = match[2]?.toLowerCase()
  return Math.round(n * (unit === 'm' ? 1_000_000 : unit === 'k' ? 1_000 : 1))
}

interface Candidate {
  provider: CatalogProvider['provider']
  model: CatalogModel
}

/** Among the models matching every word asked, the one with fewest other words, then the newest version. */
function best(candidates: Candidate[], query: string[]): Candidate[] {
  const scored = candidates.map((c) => {
    const words = new Set([...tokens(c.model.modelId), ...tokens(c.model.displayName)])
    const extra = tokens(c.model.modelId).filter((t) => !/^\d+$/.test(t) && !query.includes(t)).length
    return { c, words, extra, version: version(c.model.modelId) }
  })
  const matching = scored.filter((s) => query.every((q) => s.words.has(q)))
  if (!matching.length) return []
  matching.sort((a, b) => a.extra - b.extra || compareVersions(b.version, a.version))
  const top = matching[0] as (typeof matching)[number]
  return matching
    .filter((s) => s.extra === top.extra && compareVersions(s.version, top.version) === 0)
    .map((s) => s.c)
}

function describe(c: Candidate): string {
  return `${c.model.displayName} (${c.model.modelId}, ${c.provider.name})`
}

/** Resolves what the user asked for into a model choice, or says what is wrong and what exists. */
export function resolveModelRequest(catalog: CatalogProvider[], request: ModelRequest): ModelRequestResult {
  const notes: string[] = []
  let providers = catalog
  if (request.provider?.trim()) {
    const wanted = tokens(request.provider).join(' ')
    providers = catalog.filter(
      (p) =>
        p.provider.id === request.provider ||
        [p.provider.name, p.provider.type.replace('_', ' '), p.provider.preset ?? ''].some((name) =>
          tokens(name).join(' ').includes(wanted),
        ),
    )
    if (!providers.length)
      return {
        ok: false,
        error: `No provider called "${request.provider}". Providers: ${catalog.map((p) => p.provider.name).join(', ')}.`,
      }
  }

  let query = tokens(request.model ?? '')
  let context = parseContextLimit(request.context)
  if (context === 'invalid')
    return { ok: false, error: `"${String(request.context)}" is not a context size (e.g. 200000, 256k, 1m).` }
  if (query.includes('1m')) {
    query = query.filter((t) => t !== '1m')
    context ??= 1_000_000
  }

  const all: Candidate[] = providers.flatMap((p) =>
    p.models.map((model) => ({ provider: p.provider, model })),
  )
  let picked: Candidate | undefined
  if (!query.length) {
    const first = providers[0]
    const model = first?.models[0]
    if (!first || !model) return { ok: false, error: 'Say which model (list_models shows them).' }
    picked = { provider: first.provider, model }
  } else {
    const exact = (request.model ?? '').trim().toLowerCase()
    picked = all.find((c) => c.model.modelId.toLowerCase() === exact)
    if (!picked) {
      for (const p of providers) {
        const matches = best(
          p.models.map((model) => ({ provider: p.provider, model })),
          query,
        )
        if (matches.length === 1) {
          picked = matches[0]
          break
        }
        if (matches.length > 1)
          return {
            ok: false,
            error: `"${request.model}" matches several models: ${matches.map(describe).join('; ')}. Name one.`,
          }
      }
    }
  }
  if (!picked) {
    const known = all.slice(0, MAX_LISTED).map(describe).join('; ')
    return {
      ok: false,
      error: `No model matches "${request.model}". ${known ? `Available: ${known}.` : 'No model is configured.'} (list_models shows them all)`,
    }
  }

  let effort: string | null = null
  if (request.effort?.trim()) {
    const levels = picked.model.efforts
    const asked = normalizeEffort(request.effort)
    const unknownCustom =
      asked !== null &&
      !isStandardEffort(asked) &&
      !!levels?.length &&
      !levels.some((level) => level.toLowerCase() === asked.toLowerCase())
    if (asked === null || unknownCustom)
      return {
        ok: false,
        error: `"${request.effort}" is not an effort level of ${picked.model.displayName}: use one of ${(levels?.length ? levels : REASONING_EFFORTS).join(', ')}.`,
      }
    effort = pickEffort(asked, levels)
    if (!effort) notes.push(`${picked.model.displayName} takes no reasoning effort: it runs without one.`)
    else if (effort.toLowerCase() !== asked.toLowerCase())
      notes.push(`${picked.model.displayName} does not accept effort ${asked}: it runs at ${effort}.`)
  }

  const window = picked.model.contextWindow
  if (context !== null && context < MIN_CONTEXT_LIMIT)
    return { ok: false, error: `The context must be at least ${MIN_CONTEXT_LIMIT} tokens.` }
  if (context !== null && window && context >= window) {
    if (context > window)
      notes.push(
        `${picked.model.displayName} holds at most ${window} tokens of context: it uses its whole window.`,
      )
    context = null
  }

  const choice: ModelChoice = {
    providerId: picked.provider.id,
    model: picked.model.modelId,
    effort,
    contextLimit: context,
    maxOutputTokens: null,
  }
  const label = [
    `${picked.model.displayName} (${picked.provider.name})`,
    effort ? `effort ${effort}` : null,
    context ? `context ${context}` : null,
  ]
    .filter(Boolean)
    .join(', ')
  return { ok: true, choice, label, notes }
}

/** The `list_models` answer: each provider's models with their window and efforts. */
export function describeCatalog(catalog: CatalogProvider[], query?: string | null): string {
  const words = tokens(query ?? '')
  const lines: string[] = []
  for (const { provider, models } of catalog) {
    const shown = words.length
      ? models.filter((m) => {
          const all = new Set([...tokens(m.modelId), ...tokens(m.displayName)])
          return words.every((w) => all.has(w))
        })
      : models
    if (!shown.length) continue
    lines.push(`${provider.name} (${provider.type}):`)
    for (const m of shown.slice(0, MAX_LISTED)) {
      const efforts =
        m.efforts === null
          ? 'efforts unknown'
          : m.efforts.length
            ? `efforts ${m.efforts.join('/')}`
            : 'no effort'
      const window = m.contextWindow ? `${Math.round(m.contextWindow / 1000)}k context` : 'context unknown'
      lines.push(`- ${m.modelId} — ${m.displayName}; ${window}; ${efforts}`)
    }
    if (shown.length > MAX_LISTED)
      lines.push(`- … ${shown.length - MAX_LISTED} more (pass a query to narrow)`)
  }
  return lines.length
    ? lines.join('\n')
    : words.length
      ? `No model matches "${query}".`
      : 'No model is configured.'
}

/**
 * What a bot asked for: a named model, or, with only an effort or a context, the model it works on now
 * (`current`: its lane's, else its own).
 */
export function resolveBotModelRequest(
  models: ModelCatalog,
  bot: Bot,
  request: ModelRequest,
  current: ModelChoice | null,
): ModelRequestResult {
  const catalog = models.catalog(bot)
  if (request.model?.trim()) return resolveModelRequest(catalog, request)
  const base = current ?? models.currentChoice(bot)
  if (!base?.model) return { ok: false, error: 'No model is configured: say which model (list_models).' }
  return resolveModelRequest(catalog, {
    ...request,
    model: base.model,
    provider: base.providerId,
    context: request.context ?? base.contextLimit,
    effort: request.effort ?? base.effort,
  })
}

/** What plans and work sessions use to turn a bot's request into a model choice. */
export interface ModelRequests {
  /** `current`: the model the asking lane works on (effort-only requests keep it). */
  request(bot: Bot, request: ModelRequest, current: ModelChoice | null): ModelRequestResult
  list(bot: Bot, query: string | null): string
}

export function modelRequests(models: ModelCatalog): ModelRequests {
  return {
    request: (bot, request, current) => resolveBotModelRequest(models, bot, request, current),
    list: (bot, query) => describeCatalog(models.catalog(bot), query),
  }
}

/** The model arguments of a tool call (`model`, `effort`, `context`, `provider`), null when none is given. */
export function modelRequestArgs(args: Record<string, unknown>): ModelRequest | null {
  const text = (key: string) => (typeof args[key] === 'string' ? (args[key] as string).trim() : '')
  const request = {
    model: text('model') || null,
    effort: text('effort') || null,
    context: text('context') || (typeof args.context === 'number' ? args.context : null),
    provider: text('provider') || null,
  }
  return request.model || request.effort || request.context || request.provider ? request : null
}

export function modelRequestNote(result: Extract<ModelRequestResult, { ok: true }>): string {
  return [`It runs on ${result.label}.`, ...result.notes].join(' ')
}

/**
 * What `set_model` writes on a bot (the fields the bot settings panel changes). `providerId`/`model` only
 * come when the bot switches model or provider: an effort or context change alone leaves them as they are,
 * so a bot that follows the default model or provider (null) keeps following it, like the panel.
 */
export type BotModelPatch = Pick<ModelChoice, 'effort' | 'contextLimit'> &
  Partial<Pick<ModelChoice, 'providerId' | 'model'>>

export type BotModelChange =
  { ok: true; patch: BotModelPatch; label: string; notes: string[] } | { ok: false; error: string }

const isDefault = (value: string | number | null | undefined) =>
  typeof value === 'string' && /^\s*default\s*$/i.test(value)

/**
 * A change of a bot's own model (`set_model`), with the bot settings panel's rules: a model of the catalog
 * (the current one when only the effort or context changes), an effort the model lists (any standard one
 * when its levels are unknown; "default" = the model's own) and, without one, the bot's effort kept while
 * the model takes it. Unlike work requests, an effort the model does not take is refused, not narrowed.
 */
export function resolveBotModelChange(
  models: Pick<ModelCatalog, 'catalog' | 'currentChoice'>,
  bot: Bot,
  request: ModelRequest,
): BotModelChange {
  const catalog = models.catalog(bot)
  const switching = !!(request.model?.trim() || request.provider?.trim())
  const base = models.currentChoice(bot)
  if (!switching && !base?.model)
    return { ok: false, error: 'No model is configured: say which model (list_models).' }
  const resolved = resolveModelRequest(catalog, {
    model: switching ? (request.model ?? null) : (base?.model ?? null),
    provider: switching ? (request.provider ?? null) : (base?.providerId ?? null),
    context: isDefault(request.context) ? null : (request.context ?? bot.contextLimit),
  })
  if (!resolved.ok) return resolved
  const { choice } = resolved
  const picked = catalog
    .find((p) => p.provider.id === choice.providerId)
    ?.models.find((m) => m.modelId === choice.model)
  const name = picked?.displayName ?? choice.model
  const allowed: readonly string[] = picked?.efforts ?? REASONING_EFFORTS
  const notes = [...resolved.notes]

  let effort: string | null
  const asked = request.effort?.trim()
  if (asked && isDefault(asked)) effort = null
  else if (asked) {
    if (!allowed.length) return { ok: false, error: `${name} takes no reasoning effort.` }
    const level = normalizeEffort(asked)
    const match = level && allowed.find((l) => l.toLowerCase() === level.toLowerCase())
    if (!match)
      return {
        ok: false,
        error: `"${asked}" is not an effort level of ${name}: use one of ${allowed.join(', ')}, or default.`,
      }
    effort = match
  } else {
    effort = bot.effort && allowed.includes(bot.effort) ? bot.effort : null
    if (bot.effort && !effort)
      notes.push(`${name} does not take effort ${bot.effort}: it runs at its default effort.`)
  }

  const patch: BotModelPatch = {
    ...(switching ? { providerId: choice.providerId, model: choice.model } : {}),
    effort,
    contextLimit: choice.contextLimit,
  }
  const label = [resolved.label, effort ? `effort ${effort}` : allowed.length ? 'default effort' : null]
    .filter(Boolean)
    .join(', ')
  return { ok: true, patch, label, notes }
}
