import {
  type Bot,
  type ConversationSummary,
  type EmbeddingApiModelOption,
  type EmbeddingOptions,
  type KnowledgeDoc,
  type KnowledgeEmbeddingSetting,
  type KnowledgeIndexStatus,
  KnowledgeKind,
  type KnowledgeSearchHit,
  LEGACY_OFFICE_EXTENSIONS,
} from '@milibot/shared'
import type { TFunction } from 'i18next'

import { vmFolder } from '@/features/files/lib/files'
import { formatBytes, formatRelative, formatUsd } from '@/lib/format'
import type { SelectGroupInfo, SelectOption } from '@/lib/select'

const SEP = '\u0000'
const MB = 1024 * 1024

/** Select value of a "Search model" choice (model ids may contain `:` or `/`). */
export function encodeEmbedding(setting: KnowledgeEmbeddingSetting): string {
  return setting.provider === 'local'
    ? ['local', setting.family, setting.level].join(SEP)
    : ['api', setting.providerId, setting.model].join(SEP)
}

export function decodeEmbedding(value: string): KnowledgeEmbeddingSetting | null {
  const [provider, a = '', b = ''] = value.split(SEP)
  if (provider === 'local' && (a === 'embeddinggemma' || a === 'multilingual-e5') && b)
    return { provider: 'local', family: a, level: b }
  if (provider === 'api' && a && b) return { provider: 'api', providerId: a, model: b }
  return null
}

export function isSameEmbedding(a: KnowledgeEmbeddingSetting, b: KnowledgeEmbeddingSetting): boolean {
  return encodeEmbedding(a) === encodeEmbedding(b)
}

/** "~720 MB", "~1.3 GB". */
export function formatRam(mb: number, locale: string): string {
  return `~${formatBytes(mb * MB, locale)}`
}

export function formatCount(value: number, locale: string): string {
  return new Intl.NumberFormat(locale).format(value)
}

/** "$0.02" with the cents a price per million tokens needs. */
export function formatPrice(usd: number, locale: string): string {
  return formatUsd(usd, locale, 'price')
}

/** `triggerTitle`: what precedes the option label in the closed select (null = the label alone). */
type EmbeddingGroup = SelectGroupInfo & { where: 'mac' | 'api'; triggerTitle: string | null }

export interface EmbeddingChoices {
  value: string
  options: SelectOption<string>[]
  groups: Record<string, EmbeddingGroup>
}

const QWEN_PREFIX = 'qwen/qwen3-embedding'

/** An option value that is not a setting (placeholder of an empty group). */
const NO_EMBEDDING_CHOICE = 'none'

function apiOption(
  providerId: string,
  model: EmbeddingApiModelOption,
  label: string,
  t: TFunction,
  locale: string,
  group: string,
): SelectOption<string> {
  const size = model.dimensions
    ? t('knowledge.model.dimensions', { dims: formatCount(model.dimensions, locale) })
    : t('knowledge.model.dimensionsOnChoose')
  const input = model.maxInputTokens
    ? t('knowledge.model.upTo', { tokens: formatTokenLimit(model.maxInputTokens, locale) })
    : null
  return {
    value: encodeEmbedding({ provider: 'api', providerId, model: model.model }),
    label,
    description: [size, input].filter(Boolean).join(' · '),
    meta:
      model.priceInputPerMtokUsd !== null
        ? formatPrice(model.priceInputPerMtokUsd, locale)
        : t('knowledge.model.priceUnknown'),
    metaDetail: model.priceInputPerMtokUsd !== null ? t('knowledge.model.perMillion') : undefined,
    group,
  }
}

/** The registered API model behind a select value, if any. */
export function apiEmbeddingModel(
  options: EmbeddingOptions,
  setting: KnowledgeEmbeddingSetting,
): EmbeddingApiModelOption | null {
  if (setting.provider !== 'api') return null
  return (
    options.api
      .find((p) => p.providerId === setting.providerId)
      ?.models.find((m) => m.model === setting.model) ?? null
  )
}

/**
 * Options of the "Search model" select: one group per local family ("On this computer"), then, per
 * OpenAI-compatible provider, the embedding models registered in "Providers and models" (Qwen3 Embedding
 * in its own group when registered). Without any registered model a disabled row points to "Providers and
 * models". A current API model that is no longer registered stays, marked unavailable.
 */
export function embeddingChoices(options: EmbeddingOptions, t: TFunction, locale: string): EmbeddingChoices {
  const result: EmbeddingChoices = { value: encodeEmbedding(options.current), options: [], groups: {} }
  const onThisComputer = { label: t('knowledge.model.onThisComputer'), tone: 'success' as const }

  for (const family of options.local) {
    const group = `local:${family.id}`
    const maxDims = Math.max(...family.levels.map((l) => l.dimensions))
    const sameModel = new Set(family.levels.map((l) => l.downloadBytes)).size === 1
    result.groups[group] = {
      title: family.name,
      vendor: family.vendor,
      description: t(`knowledge.model.families.${family.id}`, {
        tokens: formatTokenLimit(Math.max(...family.levels.map((l) => l.maxInputTokens)), locale),
      }),
      tag: onThisComputer,
      where: 'mac',
      triggerTitle: family.name,
    }
    for (const level of family.levels) {
      const dims = t('knowledge.model.dimensions', { dims: formatCount(level.dimensions, locale) })
      const note = t(`knowledge.model.levels.${family.id}.${level.id}.note`, { defaultValue: '' })
      const size = formatBytes(level.downloadBytes, locale)
      result.options.push({
        value: encodeEmbedding({ provider: 'local', family: family.id, level: level.id }),
        label: t(`knowledge.model.levels.${family.id}.${level.id}.name`, { defaultValue: level.id }),
        description: family.id === 'embeddinggemma' ? [dims, note].filter(Boolean).join(' · ') : note || dims,
        badge: level.recommended ? t('knowledge.model.recommended') : undefined,
        meta: t('knowledge.model.ram', { size: formatRam(level.ramMb, locale) }),
        metaDetail: sameModel
          ? `${size} · ${t('knowledge.model.indexShare', { percent: Math.round((level.dimensions / maxDims) * 100) })}`
          : size,
        group,
      })
    }
  }

  const registered = options.api.filter((p) => p.models.length > 0)
  if (registered.length === 0) {
    const group = 'api:none'
    result.groups[group] = {
      title: t('knowledge.model.apiModels'),
      description:
        options.api.length > 0 ? t('knowledge.model.noRegistered') : t('knowledge.model.noProvider'),
      where: 'api',
      triggerTitle: null,
    }
    result.options.push({
      value: NO_EMBEDDING_CHOICE,
      label: t('knowledge.model.noneRegistered'),
      disabled: true,
      group,
    })
  }

  for (const provider of registered) {
    const via = {
      label: t('knowledge.model.via', { provider: provider.name }),
      tone: provider.local ? ('success' as const) : ('neutral' as const),
    }
    const apiDescription = provider.local
      ? t('knowledge.model.localServerDescription')
      : t('knowledge.model.apiDescription')
    const qwen = provider.models.filter((m) => m.model.startsWith(QWEN_PREFIX))
    const others = provider.models.filter((m) => !m.model.startsWith(QWEN_PREFIX))
    if (qwen.length > 0) {
      const group = `api:${provider.providerId}:qwen`
      result.groups[group] = {
        title: t('knowledge.model.qwen.name'),
        vendor: t('knowledge.model.qwen.vendor'),
        description: apiDescription,
        tag: via,
        where: 'api',
        triggerTitle: t('knowledge.model.qwen.name'),
      }
      for (const model of qwen) {
        const label = model.name.replace(/^.*?Qwen3 Embedding\s*/i, '') || model.name
        result.options.push(apiOption(provider.providerId, model, label, t, locale, group))
      }
    }
    if (others.length > 0) {
      const group = `api:${provider.providerId}:models`
      result.groups[group] = {
        title: t('knowledge.model.providerModels'),
        vendor: provider.name,
        description: apiDescription,
        tag: via,
        where: 'api',
        triggerTitle: null,
      }
      for (const model of others)
        result.options.push(apiOption(provider.providerId, model, model.name, t, locale, group))
    }
  }

  if (!result.options.some((o) => o.value === result.value) && options.current.provider === 'api') {
    const group = 'api:current'
    result.groups[group] = {
      title: t('knowledge.model.unavailable'),
      description: t('knowledge.model.unavailableHint'),
      where: 'api',
      triggerTitle: null,
    }
    result.options.push({ value: result.value, label: options.current.model, group })
  }
  return result
}

/** `2k` (2048), `32k` (32768 or 32000), `512`. */
function formatTokenLimit(tokens: number, locale: string): string {
  if (tokens < 1000) return String(tokens)
  const k = tokens % 1024 === 0 ? tokens / 1024 : tokens / 1000
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(k)}k`
}

/** Name of the chosen model for the trigger: where it runs, family and level. */
export function embeddingTriggerParts(
  choices: EmbeddingChoices,
  value: string,
): { where: string | null; name: string; badge: string | null } {
  const option = choices.options.find((o) => o.value === value)
  const group = option?.group ? choices.groups[option.group] : undefined
  if (!option || !group) return { where: null, name: '', badge: null }
  return {
    where: group.tag?.label ?? (option.group === 'api:current' ? group.title : null),
    name: group.triggerTitle ? `${group.triggerTitle} · ${option.label}` : option.label,
    badge: option.badge ?? null,
  }
}

export interface IndexStatusView {
  tone: 'success' | 'progress' | 'warning' | 'danger' | 'neutral'
  text: string
  /** 0..1 for a progress bar. */
  progress: number | null
  /** The unavailable state offers "Try again". */
  retry: boolean
  /** Full error (tooltip). */
  error: string | null
}

/** Status line under "Search model". */
export function indexStatusView(
  status: KnowledgeIndexStatus,
  options: EmbeddingOptions | null,
  t: TFunction,
  locale: string,
): IndexStatusView {
  const n = (v: number) => formatCount(v, locale)
  const level =
    status.embedding.provider === 'local'
      ? options?.local
          .find((f) => f.id === (status.embedding as { family: string }).family)
          ?.levels.find((l) => l.id === (status.embedding as { level: string }).level)
      : undefined
  const provider =
    status.embedding.provider === 'api'
      ? options?.api.find((p) => p.providerId === (status.embedding as { providerId: string }).providerId)
      : undefined
  const waiting = status.waitingForVm
    ? ` · ${t('knowledge.status.waitingVm', { count: status.waitingForVm })}`
    : ''
  const view = (
    patch: Partial<IndexStatusView> & Pick<IndexStatusView, 'tone' | 'text'>,
  ): IndexStatusView => ({
    progress: null,
    retry: false,
    error: null,
    ...patch,
  })

  if (options && status.embedding.provider === 'api' && !apiEmbeddingModel(options, status.embedding))
    return view({
      tone: 'danger',
      text: t('knowledge.status.unavailable', { reason: t('knowledge.status.errors.model_not_registered') }),
    })

  switch (status.state) {
    case 'downloading': {
      const d = status.download
      return view({
        tone: 'progress',
        text: d
          ? t('knowledge.status.downloading', {
              loaded: formatBytes(d.loadedBytes, locale),
              total: formatBytes(d.totalBytes, locale),
              percent: Math.round(d.progress * 100),
            })
          : t('knowledge.status.downloadingShort'),
        progress: d?.progress ?? null,
      })
    }
    case 'loading':
      return view({ tone: 'progress', text: t('knowledge.status.loading') + waiting })
    case 'indexing':
    case 'reindexing': {
      const progress = status.totalChunks ? status.indexedChunks / status.totalChunks : null
      return view({
        tone: 'progress',
        text:
          t(status.state === 'indexing' ? 'knowledge.status.indexing' : 'knowledge.status.reindexing', {
            done: n(status.indexedChunks),
            total: n(status.totalChunks),
          }) + waiting,
        progress,
      })
    }
    case 'unavailable':
      return view({
        tone: 'danger',
        text: t('knowledge.status.unavailable', {
          reason: t(`knowledge.status.errors.${status.error?.code ?? 'unknown'}`, {
            defaultValue: t('knowledge.status.errors.unknown'),
          }),
        }),
        retry: true,
        error: status.error?.message ?? null,
      })
    case 'idle': {
      const chunks = t('knowledge.status.chunks', {
        count: status.indexedChunks,
        formatted: n(status.indexedChunks),
      })
      if (status.embedding.provider === 'api')
        return view({
          tone: 'success',
          text: `${t('knowledge.status.viaProvider', { provider: provider?.name ?? '…' })} · ${chunks}${waiting}`,
        })
      if (level && !level.downloaded && status.indexedChunks === 0)
        return view({
          tone: 'neutral',
          text:
            t('knowledge.status.notDownloaded', { size: formatBytes(level.downloadBytes, locale) }) + waiting,
        })
      const onDisk = level?.downloaded ? level : null
      return view({
        tone: 'success',
        text:
          [
            onDisk ? t('knowledge.status.downloaded') : null,
            onDisk
              ? t('knowledge.status.disk', {
                  size: formatBytes(onDisk.diskBytes || onDisk.downloadBytes, locale),
                })
              : null,
            onDisk ? t('knowledge.status.ram', { size: formatRam(onDisk.ramMb, locale) }) : null,
            chunks,
          ]
            .filter(Boolean)
            .join(' · ') + waiting,
      })
    }
  }
}

/** Kinds extracted in the VM (the others are read on the host). */
const VM_KINDS = new Set<KnowledgeKind>([
  'pdf',
  'docx',
  'odt',
  'epub',
  'rtf',
  'html',
  'image',
  'pptx',
  'xlsx',
])

function waitsForVm(doc: KnowledgeDoc, vmRunning: boolean): boolean {
  return doc.status === 'queued' && doc.source !== 'bot' && !vmRunning && VM_KINDS.has(doc.kind)
}

export interface DocStatusView {
  tone: 'success' | 'progress' | 'warning' | 'danger' | 'neutral'
  label: string
  progress: number | null
}

export function docStatusView(doc: KnowledgeDoc, vmRunning: boolean, t: TFunction): DocStatusView {
  const percent = Math.round(doc.progress * 100)
  switch (doc.status) {
    case 'ready':
      return { tone: 'success', label: t('knowledge.docStatus.ready'), progress: null }
    case 'failed':
      return { tone: 'danger', label: errorTitle(doc, t), progress: null }
    case 'queued':
      return waitsForVm(doc, vmRunning)
        ? { tone: 'warning', label: t('knowledge.docStatus.waitingVm'), progress: null }
        : { tone: 'neutral', label: t('knowledge.docStatus.queued'), progress: null }
    case 'extracting':
      return {
        tone: 'progress',
        label: t('knowledge.docStatus.extracting', { percent }),
        progress: doc.progress,
      }
    case 'summarizing':
      return { tone: 'progress', label: t('knowledge.docStatus.summarizing'), progress: null }
    case 'indexing':
      return {
        tone: 'progress',
        label: t('knowledge.docStatus.indexing', { percent }),
        progress: doc.progress,
      }
  }
}

const ERROR_CODES = [
  'unsupported_format',
  'too_large',
  'timeout',
  'tools_missing',
  'legacy_office_disabled',
  'office_missing',
  'extract_failed',
  'empty',
  'file_missing',
  'vm_file_not_found',
  'internal',
] as const
type ErrorCode = (typeof ERROR_CODES)[number]

function knownError(doc: KnowledgeDoc): ErrorCode {
  return ERROR_CODES.find((code) => code === doc.errorCode) ?? 'internal'
}

function errorTitle(doc: KnowledgeDoc, t: TFunction): string {
  return t(`knowledge.errors.${knownError(doc)}.title`)
}

/**
 * What went wrong and what to do: `tools_missing` points to "Update system", an old Office file to the
 * "Old Office files" switch (turn it on, or retry its install).
 */
export function docErrorView(
  doc: KnowledgeDoc,
  t: TFunction,
): { hint: string; updateSystem: boolean; legacyOffice: 'enable' | 'retry' | null } {
  const code = knownError(doc)
  return {
    hint: t(`knowledge.errors.${code}.hint`),
    updateSystem: code === 'tools_missing',
    legacyOffice: code === 'legacy_office_disabled' ? 'enable' : code === 'office_missing' ? 'retry' : null,
  }
}

export function kindLabel(kind: KnowledgeKind, t: TFunction): string {
  return t(`knowledge.kinds.${kind}`)
}

const PAGE_UNITS: Partial<Record<KnowledgeKind, 'pages' | 'lines' | 'sheets' | 'slides'>> = {
  pdf: 'pages',
  csv: 'lines',
  xlsx: 'sheets',
  pptx: 'slides',
  image: 'pages',
}

function pagesText(doc: KnowledgeDoc, t: TFunction, locale: string): string | null {
  if (doc.pages === null) return null
  const unit = PAGE_UNITS[doc.kind] ?? 'sections'
  if (doc.ocrPages > 0 && doc.ocrPages >= doc.pages)
    return t('knowledge.detail.ocrAll', { count: doc.pages, formatted: formatCount(doc.pages, locale) })
  const text = t(`knowledge.detail.${unit}`, { count: doc.pages, formatted: formatCount(doc.pages, locale) })
  return doc.ocrPages > 0
    ? `${text} · ${t('knowledge.detail.ocrSome', { count: doc.ocrPages, formatted: formatCount(doc.ocrPages, locale) })}`
    : text
}

export function conversationName(
  conversation: ConversationSummary | undefined,
  bots: Record<string, Bot>,
): { type: 'direct' | 'group'; name: string } | null {
  if (!conversation || conversation.type === 'internal' || conversation.type === 'session') return null
  if (conversation.type === 'direct') {
    const bot = conversation.memberBotIds.map((id) => bots[id]).find(Boolean)
    return bot ? { type: 'direct', name: bot.name } : null
  }
  const name =
    conversation.title ||
    conversation.memberBotIds
      .map((id) => bots[id]?.name)
      .filter(Boolean)
      .join(', ')
  return name ? { type: 'group', name } : null
}

/** Who added the document and from where. */
function originText(
  doc: KnowledgeDoc,
  ctx: { bots: Record<string, Bot>; conversations: Record<string, ConversationSummary> },
  t: TFunction,
): string {
  const botName = doc.authorBotId ? (ctx.bots[doc.authorBotId]?.name ?? t('knowledge.detail.aBot')) : null
  switch (doc.source) {
    case 'upload':
      return t('knowledge.detail.uploaded')
    case 'attachment': {
      const conversation = conversationName(
        doc.conversationId ? ctx.conversations[doc.conversationId] : undefined,
        ctx.bots,
      )
      return conversation
        ? t(
            conversation.type === 'direct'
              ? 'knowledge.detail.attachmentDm'
              : 'knowledge.detail.attachmentGroup',
            { name: conversation.name },
          )
        : t('knowledge.detail.attachment')
    }
    case 'vm_file': {
      const folder = doc.sourceRef ? vmFolder(doc.sourceRef) : '/workspace'
      return botName
        ? t('knowledge.detail.vmFileBot', { name: botName, path: folder })
        : t('knowledge.detail.vmFileUser', { path: folder })
    }
    case 'bot':
      return t('knowledge.detail.writtenBy', { name: botName ?? t('knowledge.detail.aBot') })
  }
}

/** Second line of a document row. */
export function docDetailLine(
  doc: KnowledgeDoc,
  ctx: {
    bots: Record<string, Bot>
    conversations: Record<string, ConversationSummary>
    vmRunning: boolean
    now?: number
  },
  t: TFunction,
  locale: string,
): string {
  if (doc.status === 'failed') return docErrorView(doc, t).hint
  if (waitsForVm(doc, ctx.vmRunning))
    return `${formatBytes(doc.bytes, locale)} · ${t('knowledge.detail.readWhenVmStarts')}`
  const parts = [
    pagesText(doc, t, locale),
    doc.chunks > 0
      ? t('knowledge.detail.chunks', { count: doc.chunks, formatted: formatCount(doc.chunks, locale) })
      : null,
    doc.pages === null && doc.chunks === 0 ? formatBytes(doc.bytes, locale) : null,
    originText(doc, ctx, t),
    formatRelative(doc.createdAt, locale, ctx.now, t('time.now')),
  ]
  return parts.filter(Boolean).join(' · ')
}

export type UploadProblem = 'too_large' | 'unsupported_format' | 'legacy_office_disabled' | 'failed'

/**
 * Checked before sending (the daemon checks again and decides the format from the bytes). Old Office files
 * (.doc/.xls/.ppt/.ods/.odp) need "Old Office files" (`legacyOffice`).
 */
export function validateUpload(
  file: { name: string; size: number },
  maxFileMb: number,
  legacyOffice = false,
): UploadProblem | null {
  if (file.size > maxFileMb * MB) return 'too_large'
  if (!file.name.includes('.')) return null
  const ext = file.name.toLowerCase().split('.').pop() ?? ''
  if (UNSUPPORTED_EXTENSIONS.has(ext)) return 'unsupported_format'
  if (!legacyOffice && (LEGACY_OFFICE_EXTENSIONS as readonly string[]).includes(ext))
    return 'legacy_office_disabled'
  return null
}

/** Formats that are certainly not text (the rest is sniffed by the daemon). */
const UNSUPPORTED_EXTENSIONS = new Set([
  'zip',
  'gz',
  'tgz',
  'rar',
  '7z',
  'dmg',
  'pkg',
  'app',
  'exe',
  'mp3',
  'mp4',
  'mov',
  'wav',
  'm4a',
])

/** Reason of a refused upload from the daemon's error details. */
export function uploadProblemFromError(details: unknown): { problem: UploadProblem; maxFileMb?: number } {
  const d = (details ?? {}) as { reason?: unknown; maxFileMb?: unknown; hint?: unknown }
  if (d.hint === 'legacy_office_disabled') return { problem: 'legacy_office_disabled' }
  if (d.reason === 'too_large')
    return { problem: 'too_large', ...(typeof d.maxFileMb === 'number' ? { maxFileMb: d.maxFileMb } : {}) }
  if (d.reason === 'unsupported_format') return { problem: 'unsupported_format' }
  return { problem: 'failed' }
}

export function hitLocation(hit: KnowledgeSearchHit, t: TFunction): string {
  const parts: string[] = []
  if (hit.pageFrom !== null)
    parts.push(
      hit.pageTo !== null && hit.pageTo !== hit.pageFrom
        ? t('knowledge.search.pages', { from: hit.pageFrom, to: hit.pageTo })
        : t('knowledge.search.page', { page: hit.pageFrom }),
    )
  if (hit.heading) parts.push(hit.heading)
  return parts.join(' · ')
}

/** A passage as plain text for a preview line (no heading marks, bold markers or blank lines). */
export function snippetText(text: string): string {
  return text
    .replace(/<!--[^]*?-->/g, '')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*|__/g, '')
    .replace(/\n{2,}/g, '\n')
    .trim()
}

/** Splits extracted markdown at `<!-- page N -->` markers (text before the first marker has page null). */
export function splitPages(text: string): Array<{ page: number | null; text: string }> {
  const parts: Array<{ page: number | null; text: string }> = []
  const marker = /<!--\s*page\s+(\d+)\s*-->/g
  let last = 0
  let page: number | null = null
  for (const match of text.matchAll(marker)) {
    const chunk = text.slice(last, match.index)
    if (chunk.trim()) parts.push({ page, text: chunk.trim() })
    page = Number(match[1])
    last = (match.index ?? 0) + match[0].length
  }
  const rest = text.slice(last)
  if (rest.trim()) parts.push({ page, text: rest.trim() })
  return parts
}

export const KNOWLEDGE_KINDS = KnowledgeKind.options
