import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { copyFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { type AgentHost, ftsMatchExpression, searchTerms } from '@milibot/agent'
import { lexicalQueryWeight, reciprocalRankFusion } from '@milibot/agent/embeddings'
import {
  type Bot,
  type BotScope,
  type CreateKnowledgeUploadBody,
  DEFAULT_KNOWLEDGE_CATALOG_BUDGET_TOKENS,
  estimateTokens,
  KNOWLEDGE_SETTING_KEYS,
  type KnowledgeContent,
  type KnowledgeDoc,
  type KnowledgeDocList,
  type knowledgeEndpoints,
  type KnowledgeFromAttachmentBody,
  type KnowledgeIndexStatus,
  type KnowledgeKind,
  type KnowledgeListQuery,
  type KnowledgeSearchBody,
  type KnowledgeSearchResult,
  KnowledgeSettings,
  type LogFn,
  type ProjectView,
  type UpdateKnowledgeDocBody,
  type UpdateKnowledgeSettingsBody,
  type UploadChunkBody,
  type UploadProgress,
  type WorkspaceEvent,
} from '@milibot/shared'

import { DaemonError, notFound } from '../../errors'
import { type EndpointHandlers, type Parsed } from '../../handlers'
import { hostSafeName } from '../../util/safe-path'
import type { AttachmentService } from '../attachments'
import {
  embeddingOptions,
  type EmbeddingService,
  type KnowledgeThresholds,
  probeRegisteredEmbedding,
  thresholdsForSpace,
} from '../embeddings'
import type { LegacyOfficeAccess } from '../files'
import type { ModelCatalog, ProviderStore } from '../providers'
import { resolveByRef } from '../tools-core'
import { type VmController, whenVmRunning } from '../vm'
import type { WorkspaceStore } from '../workspace-store'
import { SUMMARY_CORPUS } from './corpus'
import { contentPath, docDir, noteFileName, originalPath, uploadsDir } from './files'
import { KnowledgeIntake } from './intake'
import { kindLabel, type KnowledgeCore, KnowledgePipeline } from './pipeline'
import { formatHits, hybridSearch, type SearchDeps, type SearchOutcome, suggestDocs } from './search'
import { canSee, type DocPatch, type DocRow, type KnowledgeStore, toDoc } from './store'

function defaultProjectView(current: string | null): ProjectView {
  return { mode: 'default', current }
}

const UI_PART_CHARS = 60_000
const STATUS_THROTTLE_MS = 250
export const MAX_NOTE_DOC_CHARS = 400_000

/** What knowledge needs from the projects domain (built after it). */
interface KnowledgeProjects {
  exists(projectId: string): boolean
  /** Project of a conversation, null for none or an unknown conversation. */
  ofConversation(conversationId: string): string | null
}

export interface KnowledgeServiceDeps {
  docs: KnowledgeStore
  store: WorkspaceStore
  projects: KnowledgeProjects
  workspaceDir: string
  vm: Pick<VmController, 'status' | 'runningGuest' | 'subscribe'>
  host: Pick<AgentHost, 'writeText'>
  providers: ProviderStore
  catalog: ModelCatalog
  attachments: Pick<AttachmentService, 'get' | 'stagedFile' | 'maxFileMb'>
  emit: (event: WorkspaceEvent) => void
  /** The workspace's vector side (shared with plans). */
  embeddings: EmbeddingService
  /** Shared model cache (`<dataRoot>/models`), for the download state of the local models. */
  modelsDir: string | null
  now: () => number
  fetch?: typeof fetch
  /** Where downloads are copied (default: `$TMPDIR/milibot-knowledge`). */
  exportDir?: string
  /** Overrides the thresholds of the active space (tests). */
  thresholds?: Partial<KnowledgeThresholds>
  /** `legacyOffice` preference: .doc/.xls/.ppt/.ods/.odp are read with LibreOffice in the VM. */
  legacyOffice?: () => LegacyOfficeAccess
  log?: LogFn
}

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  if (flat.length <= max) return flat
  const cut = flat.slice(0, max)
  const sentence = cut.lastIndexOf('. ')
  return sentence > max * 0.5 ? cut.slice(0, sentence + 1) : `${cut.trimEnd()}…`
}

/** Splits text into parts of at most `maxChars`, at paragraph (else line) boundaries. */
export function splitParts(text: string, maxChars: number): string[] {
  if (text.length <= maxChars) return [text]
  const parts: string[] = []
  let rest = text
  while (rest.length > maxChars) {
    const window = rest.slice(0, maxChars)
    let cut = window.lastIndexOf('\n\n')
    if (cut < maxChars * 0.5) cut = window.lastIndexOf('\n')
    if (cut < maxChars * 0.5) cut = maxChars
    parts.push(rest.slice(0, cut).trimEnd())
    rest = rest.slice(cut).replace(/^\n+/, '')
  }
  if (rest.trim()) parts.push(rest)
  return parts
}

/** `<!-- page N -->` markers as the models read them. */
export function modelPageMarkers(text: string): string {
  return text.replace(/^<!-- page (\d+) -->[ \t]*$/gm, '--- page $1 ---')
}

/**
 * The knowledge base of a workspace: documents (files on the host + rows), the ingestion pipeline
 * (`pipeline.ts`) and how documents come in (`intake.ts`), hybrid search, the context blocks of the bots and
 * the routes of Settings › Knowledge.
 */
export class KnowledgeService {
  readonly docs: KnowledgeStore
  readonly embeddings: EmbeddingService
  private readonly pipeline: KnowledgePipeline
  private readonly intake: KnowledgeIntake
  private unsubscribe: (() => void) | null = null
  private stopped = false
  private statusTimer: NodeJS.Timeout | null = null
  private readonly contentCache = new Map<string, { mtimeMs: number; text: string }>()

  constructor(private readonly deps: KnowledgeServiceDeps) {
    this.docs = deps.docs
    this.embeddings = deps.embeddings
    deps.embeddings.onStatus(() => this.emitIndexStatus())
    const core: KnowledgeCore = {
      deps,
      docs: this.docs,
      embeddings: this.embeddings,
      toDoc: (row) => this.toDoc(row),
      changed: (id) => this.changed(id),
      set: (id, patch) => this.set(id, patch),
      readContent: (id) => this.readContent(id),
      writeContent: (id, content) => this.writeContent(id, content),
      forgetContent: (id) => this.contentCache.delete(id),
      legacyOffice: () => this.legacyOffice(),
      emitIndexStatus: () => this.emitIndexStatus(),
      stopped: () => this.stopped,
      log: (level, message, extra) => this.log(level, message, extra),
    }
    this.pipeline = new KnowledgePipeline(core)
    this.intake = new KnowledgeIntake(core, this.pipeline, this)
  }

  private log(level: 'info' | 'warn' | 'error', message: string, extra?: Record<string, unknown>): void {
    this.deps.log?.(level, message, extra)
  }

  private get searchDeps(): SearchDeps {
    return { store: this.docs, embeddings: this.embeddings, readContent: (id) => this.readContent(id) }
  }

  start(): void {
    this.docs.requeueInterrupted()
    this.markMissingFiles()
    rmSync(uploadsDir(this.deps.workspaceDir), { recursive: true, force: true })
    this.pipeline.resumeSummaries()
    this.unsubscribe = whenVmRunning(this.deps.vm, () => {
      this.pump()
      this.pipeline.summarizeStaleNow()
    })
    this.pump()
    this.embeddings.schedule()
  }

  async stop(): Promise<void> {
    this.stopped = true
    this.unsubscribe?.()
    this.unsubscribe = null
    this.pipeline.halt()
    if (this.statusTimer) clearTimeout(this.statusTimer)
    this.embeddings.stop()
    await this.pipeline.settled()
  }

  /** Resolves when no document is being processed nor waiting to (tests). */
  async idle(): Promise<void> {
    for (let i = 0; i < 50; i++) {
      await this.pipeline.settled()
      await this.embeddings.whenIdle()
      if (this.pipeline.idle()) return
      await new Promise((r) => setTimeout(r, 5))
    }
  }

  pump(): void {
    this.pipeline.pump()
  }

  /** Documents whose stored files are gone (e.g. a backup imported without them) fail with `file_missing`. */
  private markMissingFiles(): void {
    for (const row of this.docs.all()) {
      if (row.status === 'failed') continue
      const hasContent = existsSync(contentPath(this.deps.workspaceDir, row.id))
      const hasOriginal = existsSync(originalPath(this.deps.workspaceDir, row.id, row.file_name))
      const fetchable = row.source === 'attachment' || row.source === 'vm_file'
      const missing =
        row.source === 'bot'
          ? !hasContent
          : row.status === 'queued'
            ? !hasOriginal && !fetchable
            : !hasContent
      if (missing) {
        this.docs.update(row.id, {
          status: 'failed',
          errorCode: 'file_missing',
          error: 'The stored file of this document is missing; add it again.',
        })
      }
    }
  }

  toDoc(row: DocRow): KnowledgeDoc {
    const active = this.embeddings.active()?.space ?? null
    return toDoc(row, row.chunk_count > 0 && !this.docs.notEmbedded(active, [row.id]).has(row.id))
  }

  doc(id: string): KnowledgeDoc {
    return this.toDoc(this.docs.row(id))
  }

  private changed(id: string): KnowledgeDoc | null {
    const row = this.docs.find(id)
    if (!row) return null
    const doc = this.toDoc(row)
    this.deps.emit({ type: 'knowledge.doc.updated', payload: { doc } })
    this.emitIndexStatus()
    return doc
  }

  private set(id: string, patch: DocPatch): void {
    if (!this.docs.find(id)) return
    this.docs.update(id, patch)
    this.changed(id)
  }

  indexStatus(): KnowledgeIndexStatus {
    const state = this.embeddings.status()
    const space = state.targetSpace ?? state.activeSpace
    const totalChunks = this.docs.totalChunks()
    const vmRunning = this.deps.vm.status().state === 'running'
    const queued = this.docs.withStatus('queued')
    return {
      state: state.state,
      embedding: this.embeddings.configured(),
      activeSpace: state.activeSpace,
      targetSpace: state.targetSpace,
      download: state.download,
      indexedChunks: space ? totalChunks - this.docs.countChunksToEmbed(space) : 0,
      totalChunks,
      pendingDocs: this.docs.countByStatus('queued', 'extracting', 'summarizing', 'indexing'),
      waitingForVm: vmRunning ? 0 : queued.filter((r) => this.pipeline.needsVmNow(r)).length,
      error: state.error,
    }
  }

  private emitIndexStatus(): void {
    if (this.statusTimer || this.stopped) return
    this.statusTimer = setTimeout(() => {
      this.statusTimer = null
      if (!this.stopped)
        this.deps.emit({ type: 'knowledge.index.status', payload: { status: this.indexStatus() } })
    }, STATUS_THROTTLE_MS)
    this.statusTimer.unref()
  }

  async list(query: Parsed<typeof KnowledgeListQuery>): Promise<KnowledgeDocList> {
    const filter = {
      ...(query.kind ? { kind: query.kind } : {}),
      ...(query.author ? { author: query.author } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.pinned !== undefined ? { pinned: query.pinned } : {}),
      ...(query.projectId
        ? {
            project:
              query.projectId === 'general'
                ? ({ mode: 'general' } as const)
                : ({ mode: 'only', projectId: query.projectId } as const),
          }
        : {}),
    }
    const offset = (query.page - 1) * query.pageSize
    let rows: DocRow[]
    let total: number
    if (query.q?.trim()) {
      const ids = await this.matchDocs(query.q, filter, null)
      total = ids.length
      rows = ids.slice(offset, offset + query.pageSize).flatMap((id) => this.docs.find(id) ?? [])
    } else {
      ;({ rows, total } = this.docs.list(filter, { offset, limit: query.pageSize }))
    }
    const active = this.embeddings.active()?.space ?? null
    const partial = this.docs.notEmbedded(
      active,
      rows.map((r) => r.id),
    )
    return {
      docs: rows.map((r) => toDoc(r, r.chunk_count > 0 && !partial.has(r.id))),
      total,
      page: query.page,
      pageSize: query.pageSize,
      pageCount: Math.max(1, Math.ceil(total / query.pageSize)),
      totalAll: this.docs.count(),
      index: this.indexStatus(),
    }
  }

  /** Documents matching a query over title, file name and summary (full text + summary vectors), best first. */
  private async matchDocs(
    q: string,
    filter: Parameters<KnowledgeStore['ids']>[0],
    botId: string | null,
  ): Promise<string[]> {
    const scoped = { ...filter, ...(botId ? { botId } : {}) }
    const allowed = new Set(this.docs.ids(scoped))
    const match = ftsMatchExpression(searchTerms(q))
    const textIds = match ? this.docs.searchDocs(match, scoped, 200) : []
    const vector = await this.embeddings.queryVector(q, { timeoutMs: 10_000, loadModel: false })
    const vectorIds = vector
      ? this.embeddings
          .searchCorpus(SUMMARY_CORPUS, vector, 50, allowed)
          .filter((h) => h.score >= this.thresholds().suggestMinScore)
          .map((h) => h.id)
      : []
    return reciprocalRankFusion<string>(
      [
        { ids: textIds, weight: vector ? lexicalQueryWeight(q) : 1 },
        { ids: vectorIds, weight: 1 },
      ],
      { k: 60 },
    ).map((f) => f.id)
  }

  update(id: string, body: UpdateKnowledgeDocBody): KnowledgeDoc {
    const row = this.docs.row(id)
    this.docs.update(id, {
      ...(body.title !== undefined ? { title: body.title } : {}),
      ...(body.scope !== undefined ? { scope: body.scope } : {}),
      ...(body.pinned !== undefined ? { pinned: body.pinned } : {}),
      ...(body.projectId !== undefined ? { projectId: this.checkProject(body.projectId) } : {}),
    })
    if (body.title !== undefined && body.title !== row.title)
      void this.embeddings.refreshCorpus(SUMMARY_CORPUS, [id])
    return this.changed(id) as KnowledgeDoc
  }

  async delete(id: string): Promise<void> {
    this.docs.row(id)
    this.pipeline.abort(id)
    const chunkIds = this.docs.chunks(id).map((c) => c.id)
    this.docs.delete(id)
    this.embeddings.forgetChunks(chunkIds)
    this.embeddings.forgetCorpusItem(SUMMARY_CORPUS, id)
    this.contentCache.delete(id)
    this.pipeline.forget(id)
    await rm(docDir(this.deps.workspaceDir, id), { recursive: true, force: true })
    this.deps.emit({ type: 'knowledge.doc.deleted', payload: { docId: id } })
    this.emitIndexStatus()
  }

  /** Extract (or re-read), summarize and index again from the stored file. */
  reindex(id: string): KnowledgeDoc {
    const row = this.docs.row(id)
    this.pipeline.abort(id)
    const original = originalPath(this.deps.workspaceDir, id, row.file_name)
    if (
      row.source !== 'bot' &&
      !existsSync(original) &&
      row.source !== 'vm_file' &&
      row.source !== 'attachment'
    )
      throw new DaemonError('conflict', 'The stored file of this document is missing', {
        reason: 'file_missing',
      })
    this.docs.update(id, { status: 'queued', progress: 0, errorCode: null, error: null, summary: null })
    const doc = this.changed(id) as KnowledgeDoc
    this.pump()
    return doc
  }

  readContent(id: string): string | null {
    const path = contentPath(this.deps.workspaceDir, id)
    try {
      const { mtimeMs } = statSync(path)
      const cached = this.contentCache.get(id)
      if (cached && cached.mtimeMs === mtimeMs) return cached.text
      const text = readFileSync(path, 'utf8')
      this.contentCache.set(id, { mtimeMs, text })
      if (this.contentCache.size > 16)
        this.contentCache.delete(this.contentCache.keys().next().value as string)
      return text
    } catch {
      return null
    }
  }

  content(id: string, part: number): KnowledgeContent {
    const row = this.docs.row(id)
    const text = this.readContent(id)
    if (text === null)
      throw new DaemonError('conflict', 'The document has no content yet', { reason: 'not_extracted' })
    const parts = splitParts(text, UI_PART_CHARS)
    const index = Math.min(Math.max(1, part), parts.length)
    return {
      docId: id,
      title: row.title,
      part: index,
      parts: parts.length,
      text: parts[index - 1] ?? '',
      summary: row.summary,
    }
  }

  async export(id: string): Promise<{ path: string; fileName: string }> {
    const row = this.docs.row(id)
    const source =
      row.source === 'bot'
        ? contentPath(this.deps.workspaceDir, id)
        : originalPath(this.deps.workspaceDir, id, row.file_name)
    if (!existsSync(source))
      throw new DaemonError('conflict', 'The file of this document is not available', {
        reason: 'file_missing',
      })
    const fileName = hostSafeName(row.source === 'bot' ? noteFileName(row.title) : row.file_name)
    const dir = join(this.deps.exportDir ?? join(tmpdir(), 'milibot-knowledge'), id)
    mkdirSync(dir, { recursive: true })
    const target = join(dir, fileName)
    await copyFile(source, target)
    return { path: target, fileName }
  }

  createUpload(body: Parsed<typeof CreateKnowledgeUploadBody>): UploadProgress {
    return this.intake.createUpload(body)
  }

  writeUploadChunk(id: string, chunk: UploadChunkBody): Promise<{ received: number }> {
    return this.intake.writeUploadChunk(id, chunk)
  }

  completeUpload(id: string): Promise<KnowledgeDoc> {
    return this.intake.completeUpload(id)
  }

  cancelUpload(id: string): Promise<void> {
    return this.intake.cancelUpload(id)
  }

  fromAttachment(body: KnowledgeFromAttachmentBody): Promise<KnowledgeDoc> {
    return this.intake.fromAttachment(body)
  }

  addFromVm(...args: Parameters<KnowledgeIntake['addFromVm']>): ReturnType<KnowledgeIntake['addFromVm']> {
    return this.intake.addFromVm(...args)
  }

  writeNote(...args: Parameters<KnowledgeIntake['writeNote']>): ReturnType<KnowledgeIntake['writeNote']> {
    return this.intake.writeNote(...args)
  }

  editNote(...args: Parameters<KnowledgeIntake['editNote']>): ReturnType<KnowledgeIntake['editNote']> {
    return this.intake.editNote(...args)
  }

  private legacyOffice(): LegacyOfficeAccess {
    return this.deps.legacyOffice?.() ?? { enabled: false, installing: false, progress: null }
  }

  /** LibreOffice is ready: documents that failed for lack of it are read again. */
  legacyOfficeReady(): void {
    let requeued = 0
    for (const row of this.docs.withStatus('failed')) {
      if (row.error_code !== 'legacy_office_disabled' && row.error_code !== 'office_missing') continue
      this.set(row.id, { status: 'queued', progress: 0, errorCode: null, error: null })
      requeued++
    }
    if (requeued) this.log('info', 'old Office documents queued again', { count: requeued })
    this.pump()
  }

  private writeContent(id: string, content: string): void {
    mkdirSync(docDir(this.deps.workspaceDir, id), { recursive: true })
    const path = contentPath(this.deps.workspaceDir, id)
    const partial = `${path}.partial`
    writeFileSyncAtomic(partial, path, content)
    this.contentCache.delete(id)
  }

  settings(): KnowledgeSettings {
    const get = <T>(key: string, fallback: T) => this.deps.store.settings.get<T>(key, fallback)
    const budget = get<unknown>(
      KNOWLEDGE_SETTING_KEYS.catalogBudgetTokens,
      DEFAULT_KNOWLEDGE_CATALOG_BUDGET_TOKENS,
    )
    const parsedBudget = KnowledgeSettings.shape.catalogBudgetTokens.safeParse(budget)
    return {
      embedding: this.embeddings.configured(),
      autoRetrieve: get<unknown>(KNOWLEDGE_SETTING_KEYS.autoRetrieve, false) === true,
      suggestDocs: get<unknown>(KNOWLEDGE_SETTING_KEYS.suggestDocs, true) !== false,
      catalogBudgetTokens: parsedBudget.success ? parsedBudget.data : DEFAULT_KNOWLEDGE_CATALOG_BUDGET_TOKENS,
    }
  }

  updateSettings(body: UpdateKnowledgeSettingsBody): KnowledgeSettings {
    const before = JSON.stringify(this.embeddings.configured())
    for (const key of Object.keys(body) as Array<keyof typeof body>) {
      if (body[key] !== undefined) this.deps.store.settings.set(KNOWLEDGE_SETTING_KEYS[key], body[key])
    }
    if (body.embedding && JSON.stringify(this.embeddings.configured()) !== before) {
      this.log('info', 'knowledge embedding model changed', { embedding: body.embedding })
      this.embeddings.retry()
    }
    return this.settings()
  }

  async search(body: Parsed<typeof KnowledgeSearchBody>): Promise<KnowledgeSearchResult> {
    const started = this.deps.now()
    const outcome = await hybridSearch(this.searchDeps, {
      query: body.query,
      topK: body.topK,
      botId: null,
      ...(body.docId ? { docIds: [body.docId] } : {}),
      vector: { timeoutMs: 60_000, loadModel: true },
    })
    return {
      hits: outcome.hits.map(({ vectorScore: _score, ...hit }) => hit),
      mode: outcome.mode,
      space: outcome.space,
      tookMs: Math.max(0, this.deps.now() - started),
    }
  }

  /** `knowledge_search` of a bot (its scope; marks the documents returned as used). */
  async searchForBot(
    bot: Bot,
    query: string,
    topK: number,
    docIds: string[] | null,
    project?: ProjectView,
  ): Promise<SearchOutcome> {
    const outcome = await hybridSearch(this.searchDeps, {
      query,
      topK,
      botId: bot.id,
      docIds,
      ...(project ? { project } : {}),
      vector: { timeoutMs: 30_000, loadModel: false },
    })
    this.docs.markUsed(outcome.hits.map((h) => h.docId))
    return outcome
  }

  async listForBot(
    bot: Bot,
    input: { query?: string; kind?: KnowledgeKind; author?: string; page: number; project?: ProjectView },
  ): Promise<{ rows: DocRow[]; total: number; page: number; pageCount: number }> {
    const pageSize = 20
    const filter = {
      botId: bot.id,
      ...(input.project ? { project: input.project } : {}),
      ...(input.kind ? { kind: input.kind } : {}),
      ...(input.author ? { author: input.author } : {}),
    }
    let rows: DocRow[]
    let total: number
    if (input.query?.trim()) {
      const ids = await this.matchDocs(input.query, filter, bot.id)
      total = ids.length
      rows = ids
        .slice((input.page - 1) * pageSize, input.page * pageSize)
        .flatMap((id) => this.docs.find(id) ?? [])
    } else {
      ;({ rows, total } = this.docs.list(filter, { offset: (input.page - 1) * pageSize, limit: pageSize }))
    }
    return { rows, total, page: input.page, pageCount: Math.max(1, Math.ceil(total / pageSize)) }
  }

  /** Fixed block of every bot's context (see `KnowledgeContext.catalog`): general documents only. */
  catalog(bot: Bot): string {
    const budget = this.settings().catalogBudgetTokens
    if (budget <= 0) return ''
    const view = { mode: 'general' } as const
    const total = this.docs.countVisible(bot.id, view)
    if (!total) return ''
    const header =
      `# Knowledge base\n${total} general document${total === 1 ? '' : 's'} (added by the user or written by the team): ` +
      'search with knowledge_search, browse with knowledge_list, read with knowledge_read; cite the document and page.'
    return this.catalogLines(bot, header, view, budget)
  }

  /** The documents of one project, for its block in the context ('' without documents). */
  projectCatalog(bot: Bot, projectId: string): string {
    const budget = this.settings().catalogBudgetTokens
    if (budget <= 0) return ''
    const view = { mode: 'only', projectId } as const
    const total = this.docs.countVisible(bot.id, view)
    if (!total) return ''
    const header = `## Project documents\n${total} document${total === 1 ? '' : 's'} of this project (knowledge_search finds them).`
    return this.catalogLines(bot, header, view, budget)
  }

  private catalogLines(bot: Bot, header: string, view: ProjectView, budget: number): string {
    const pinned = this.docs.pinnedFor(bot.id, 10, view)
    let used = estimateTokens(header) + 4
    const lines: string[] = []
    for (const row of pinned) {
      const summary = row.summary ? ` — ${oneLine(row.summary, 140)}` : ''
      const line = `- ${row.title} (${kindLabel(row)})${summary}`
      const cost = estimateTokens(line)
      if (used + cost > budget) break
      used += cost
      lines.push(line)
    }
    if (!lines.length) return header
    const omitted = this.docs.countPinned(bot.id, view) - lines.length
    if (omitted > 0) lines.push(`(${omitted} more pinned: knowledge_list)`)
    return `${header}\nPinned documents:\n${lines.join('\n')}`
  }

  /** Thresholds measured for the model of the active space. */
  private thresholds(): KnowledgeThresholds {
    return { ...thresholdsForSpace(this.embeddings.active()?.space ?? null), ...this.deps.thresholds }
  }

  /** Per-turn block (see `KnowledgeContext.forTurn`). */
  async forTurn(
    bot: Bot,
    query: string,
    signal: AbortSignal,
    projectId: string | null = null,
  ): Promise<string> {
    const settings = this.settings()
    if ((!settings.suggestDocs && !settings.autoRetrieve) || signal.aborted) return ''
    const project = defaultProjectView(projectId)
    if (!this.docs.countVisible(bot.id, project)) return ''
    const thresholds = this.thresholds()
    const blocks: string[] = []
    if (settings.suggestDocs) {
      const pinned = new Set(this.docs.pinnedFor(bot.id, 10, project).map((r) => r.id))
      const docs = await suggestDocs(this.searchDeps, {
        query,
        botId: bot.id,
        project,
        limit: 4,
        exclude: pinned,
        minVectorScore: thresholds.suggestMinScore,
        minTerms: thresholds.minTerms,
        proseMinTerms: thresholds.proseMinTerms,
        timeoutMs: 4000,
      })
      if (docs.length) {
        const lines = docs.map(
          (d) => `- ${d.title} (${kindLabel(d)}, ${d.id})${d.summary ? ` — ${oneLine(d.summary, 140)}` : ''}`,
        )
        blocks.push(
          `[Milibot knowledge] Documents that may be relevant to the message below (search or read them if useful):\n${lines.join('\n')}`,
        )
      }
    }
    if (settings.autoRetrieve && !signal.aborted) {
      const outcome = await hybridSearch(this.searchDeps, {
        query,
        topK: 3,
        botId: bot.id,
        project,
        vector: { timeoutMs: 4000, loadModel: false },
        threshold: { ...thresholds, minVectorScore: thresholds.chunkMinScore },
      })
      if (outcome.hits.length) {
        this.docs.markUsed(outcome.hits.map((h) => h.docId))
        blocks.push(
          `[Milibot knowledge] Excerpts that may be relevant (read more with knowledge_read):\n${formatHits(outcome.hits, { maxTokens: 1000 })}`,
        )
      }
    }
    return blocks.join('\n\n')
  }

  handlers(): EndpointHandlers<keyof typeof knowledgeEndpoints> {
    return {
      listKnowledge: ({ query }) => this.list(query),
      getKnowledgeIndex: () => this.indexStatus(),
      retryKnowledgeIndex: () => {
        this.embeddings.retry()
        this.pump()
        return this.indexStatus()
      },
      getKnowledgeSettings: () => this.settings(),
      updateKnowledgeSettings: ({ body }) => this.updateSettings(body),
      getEmbeddingOptions: () =>
        embeddingOptions({
          current: this.embeddings.configured(),
          modelsDir: this.deps.modelsDir,
          download: this.embeddings.status().download,
          providers: this.deps.providers,
        }),
      probeEmbeddingModel: ({ body }) =>
        probeRegisteredEmbedding({
          providers: this.deps.providers,
          providerId: body.providerId,
          model: body.model,
          ...(this.deps.fetch ? { fetch: this.deps.fetch } : {}),
        }),
      searchKnowledge: ({ body }) => this.search(body),
      createKnowledgeUpload: ({ body }) => this.createUpload(body),
      uploadKnowledgeChunk: ({ params, body }) => this.writeUploadChunk(params.uploadId, body),
      completeKnowledgeUpload: ({ params }) => this.completeUpload(params.uploadId),
      cancelKnowledgeUpload: async ({ params }) => {
        await this.cancelUpload(params.uploadId)
        return { ok: true as const }
      },
      addKnowledgeFromAttachment: ({ body }) => this.fromAttachment(body),
      getKnowledgeDoc: ({ params }) => this.doc(params.docId),
      getKnowledgeContent: ({ params, query }) => this.content(params.docId, query.part),
      updateKnowledgeDoc: ({ params, body }) => this.update(params.docId, body),
      deleteKnowledgeDoc: async ({ params }) => {
        await this.delete(params.docId)
        return { ok: true as const }
      },
      reindexKnowledgeDoc: ({ params }) => this.reindex(params.docId),
      exportKnowledgeDoc: ({ params }) => this.export(params.docId),
    }
  }

  /**
   * A document a bot refers to among the ones it can see: its id, else the only one titled (or named) so, else
   * the only one whose title contains the reference.
   */
  resolveDoc(bot: Bot, ref: string): DocRow | { problem: string } {
    const value = ref.trim()
    if (!value) return { problem: '"doc" is required (a document id or title).' }
    const byId = this.docs.find(value)
    if (byId) return canSee(byId, bot.id) ? byId : { problem: `No document ${value} is available to you.` }
    const visible = this.docs.ids({ botId: bot.id }).flatMap((id) => this.docs.find(id) ?? [])
    const ambiguous = { exact: 'report', partial: 'report' } as const
    const exact = resolveByRef(visible, value, {
      id: (d) => d.id,
      names: (d) => [d.title, d.file_name],
      partialAllowed: () => false,
      ambiguous,
    })
    const match =
      'missing' in exact
        ? resolveByRef(visible, value, { id: (d) => d.id, names: (d) => [d.title], ambiguous })
        : exact
    if ('found' in match) return match.found
    if ('ambiguous' in match)
      return {
        problem: `"${value}" matches ${match.ambiguous.length} documents: ${match.ambiguous
          .slice(0, 5)
          .map((d) => `${d.title} (${d.id})`)
          .join('; ')}. Use the id.`,
      }
    return { problem: `No document matches "${value}". Find it with knowledge_list or knowledge_search.` }
  }

  /** Id of the bot a person or a bot names (id, slug or name; see `WorkspaceStore.resolveBotRef`). */
  botIdByRef(ref: string): string | null {
    return this.deps.store.bots.resolveRef(ref)?.id ?? null
  }

  /** The document waits for the VM (to be copied from it or extracted there). */
  waitsForVm(id: string): boolean {
    const row = this.docs.find(id)
    return (
      row !== null &&
      row.status === 'queued' &&
      this.deps.vm.status().state !== 'running' &&
      this.pipeline.needsVmNow(row)
    )
  }

  /** `projectId` when that project exists (null stays null). */
  checkProject(projectId: string | null): string | null {
    if (projectId && !this.deps.projects.exists(projectId)) throw notFound('project', projectId)
    return projectId
  }

  scopeFor(bot: Bot, value: unknown): BotScope {
    return value === 'me' ? [bot.id] : 'all'
  }
}

function writeFileSyncAtomic(partial: string, path: string, content: string): void {
  writeFileSync(partial, content)
  renameSync(partial, path)
}
