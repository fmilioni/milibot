import { existsSync, mkdirSync } from 'node:fs'
import { open, readFile, rename } from 'node:fs/promises'
import { join } from 'node:path'

import type { ResolvedModel } from '@milibot/agent'
import {
  type Bot,
  type KnowledgeDoc,
  type KnowledgeKind,
  type LogFn,
  MAX_EXTRACT_BYTES,
} from '@milibot/shared'

import { DaemonError, errorMessage } from '../../errors'
import { sha256 } from '../../util/hash'
import type { EmbeddingService } from '../embeddings'
import { decodeText, isLegacyOfficeKind, type LegacyOfficeAccess, sniffFile } from '../files'
import { createModelPolicy } from '../providers'
import { type GuestClient, GuestError } from '../vm'
import { chunkContent, DEFAULT_CHUNK_TOKENS, stripPageMarkers } from './chunker'
import { chunkRefs, SUMMARY_CORPUS } from './corpus'
import {
  csvRows,
  docDir,
  extractedContent,
  extractKindOf,
  isLegacyOfficeName,
  kindOf,
  mimeOf,
  needsVm,
  originalPath,
} from './files'
import type { KnowledgeServiceDeps } from './service'
import type { DocPatch, DocRow, KnowledgeStore } from './store'

export const MB = 1024 * 1024
const SUMMARY_INPUT_TOKENS = 8000
const SUMMARY_DEBOUNCE_MS = 2 * 60_000
/** A bot document is summarized again when this share of its chunks changed. */
const SUMMARY_CHANGE_RATIO = 0.3
/** Kinds whose `<!-- page N -->` are real pages (the others are sections cut by the extractor). */
const PAGED_KINDS = new Set<KnowledgeKind>(['pdf', 'pptx', 'xlsx', 'image'])

export const SUMMARY_SYSTEM_PROMPT = `You write the catalog entry of a document for a team of AI assistants who decide from it whether to open the document.
Write 2 to 4 sentences, at most 80 words, in the language the document is written in: what the document is, what it is for and what can be found in it (topics, key facts, periods, names). Plain text, no preamble, no markdown, no quotes.`

/** A document problem with a message meant for people and bots (`code` is stored as the doc's error). */
export class DocFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

/** The VM stopped while a document needed it: back to `queued`. */
class VmGone extends Error {}

/** What the pipeline and the intake share with `KnowledgeService`. */
export interface KnowledgeCore {
  readonly deps: KnowledgeServiceDeps
  readonly docs: KnowledgeStore
  readonly embeddings: EmbeddingService
  toDoc(row: DocRow): KnowledgeDoc
  /** Emits the document's update (null when it is gone). */
  changed(id: string): KnowledgeDoc | null
  /** Updates a document that still exists and emits it. */
  set(id: string, patch: DocPatch): void
  readContent(id: string): string | null
  writeContent(id: string, content: string): void
  forgetContent(id: string): void
  legacyOffice(): LegacyOfficeAccess
  /** Throttled `knowledge.index.status` event. */
  emitIndexStatus(): void
  stopped(): boolean
  log: LogFn
}

export function kindLabel(doc: Pick<DocRow, 'kind' | 'pages'>): string {
  const unit = doc.kind === 'csv' ? 'rows' : 'p.'
  return doc.pages ? `${doc.kind}, ${doc.pages} ${unit}` : doc.kind
}

export function kindFor(name: string, bytes: Uint8Array): KnowledgeKind {
  const sniffed = kindOf(name, sniffFile(name, bytes.subarray(0, 64 * 1024)))
  if ('unsupported' in sniffed)
    throw new DaemonError(
      'validation_failed',
      `This file cannot be added to the knowledge base (${sniffed.unsupported})`,
      {
        reason: 'unsupported_format',
      },
    )
  return sniffed.kind
}

/** Copies a VM file to the host (size limited by `attachments.max_file_mb`). */
export async function readVmFile(
  guest: GuestClient,
  path: string,
  target: string,
  maxFileMb: number,
): Promise<void> {
  const handle = await open(target, 'w')
  try {
    await guest.fsReadAll(path, {
      maxBytes: maxFileMb * MB,
      tooLarge: (size) =>
        new DocFailure('too_large', `The file is larger than ${maxFileMb} MB (${Math.ceil(size / MB)} MB)`),
      onChunk: async (bytes, offset) => {
        await handle.write(bytes, 0, bytes.length, offset)
      },
    })
  } catch (err) {
    if (err instanceof GuestError && (err.code === 'path_not_found' || err.status === 404))
      throw new DocFailure('vm_file_not_found', `No such file in the VM: ${path}`)
    if (err instanceof GuestError && err.code === 'not_a_file')
      throw new DocFailure('vm_file_not_found', `Not a file: ${path}`)
    throw err
  } finally {
    await handle.close()
  }
}

/**
 * The ingestion pipeline: one document at a time, fetch (from the VM when needed) → extract in the VM or decode
 * on the host → chunk → summarize → embed; plus the debounced summaries of documents the bots edit.
 */
export class KnowledgePipeline {
  private pumping: Promise<void> | null = null
  private pumpAgain = false
  private current: { docId: string; abort: AbortController } | null = null
  private readonly summaryTimers = new Map<string, NodeJS.Timeout>()

  constructor(private readonly core: KnowledgeCore) {}

  private get deps(): KnowledgeServiceDeps {
    return this.core.deps
  }

  private get docs(): KnowledgeStore {
    return this.core.docs
  }

  /** Summaries left stale by a previous run are written again. */
  resumeSummaries(): void {
    for (const row of this.docs.all()) if (row.summary_stale === 1) this.scheduleSummary(row.id)
  }

  /** The VM is up: stale summaries that were not scheduled (CLI engines need the VM) are written now. */
  summarizeStaleNow(): void {
    for (const row of this.docs.all())
      if (row.summary_stale === 1 && !this.summaryTimers.has(row.id)) this.scheduleSummary(row.id, 0)
  }

  /** Stops the document being processed and the pending summaries. */
  halt(): void {
    this.current?.abort.abort()
    for (const timer of this.summaryTimers.values()) clearTimeout(timer)
    this.summaryTimers.clear()
  }

  async settled(): Promise<void> {
    await this.pumping?.catch(() => undefined)
  }

  /** Nothing is being processed nor waiting to be. */
  idle(): boolean {
    return !this.pumping && !this.runnable()
  }

  /** Stops processing `id` (it was deleted, replaced or queued again). */
  abort(id: string): void {
    if (this.current?.docId === id) this.current.abort.abort()
  }

  forget(id: string): void {
    const timer = this.summaryTimers.get(id)
    if (timer) clearTimeout(timer)
    this.summaryTimers.delete(id)
  }

  needsVmNow(row: DocRow): boolean {
    if (row.source === 'bot') return false
    const hasOriginal = existsSync(originalPath(this.deps.workspaceDir, row.id, row.file_name))
    return !hasOriginal || needsVm(row.kind)
  }

  private runnable(): DocRow | null {
    const vmRunning = this.deps.vm.status().state === 'running'
    const office = this.core.legacyOffice()
    // Old Office files wait while LibreOffice is being installed (`legacyOfficeReady` pumps again).
    const waitsForOffice = (r: DocRow) =>
      office.enabled && office.installing && isLegacyOfficeName(r.file_name)
    const queued = this.docs
      .withStatus('queued')
      .find((r) => (vmRunning || !this.needsVmNow(r)) && !waitsForOffice(r))
    return queued ?? this.docs.withStatus('indexing')[0] ?? null
  }

  pump(): void {
    if (this.core.stopped()) return
    if (this.pumping) {
      this.pumpAgain = true
      return
    }
    this.pumping = (async () => {
      do {
        this.pumpAgain = false
        for (;;) {
          if (this.core.stopped()) return
          const row = this.runnable()
          if (!row) break
          await this.process(row)
        }
      } while (this.pumpAgain && !this.core.stopped())
    })()
      .catch((err: unknown) =>
        this.core.log('error', 'knowledge pipeline failed', { err: errorMessage(err) }),
      )
      .finally(() => {
        this.pumping = null
        this.core.emitIndexStatus()
      })
  }

  private async process(row: DocRow): Promise<void> {
    const abort = new AbortController()
    this.current = { docId: row.id, abort }
    try {
      if (row.status === 'queued') {
        await this.extract(row, abort.signal)
        if (!this.alive(row.id, abort)) return
        await this.summarize(row.id, abort.signal)
        if (!this.alive(row.id, abort)) return
        this.core.set(row.id, { status: 'indexing', progress: 0 })
      }
      await this.core.embeddings.embedDocument(row.id, (done, total) => {
        if (this.alive(row.id, abort)) this.core.set(row.id, { progress: total ? done / total : 1 })
      })
      if (!this.alive(row.id, abort)) return
      this.core.set(row.id, { status: 'ready', progress: 1, indexedAt: this.deps.now() })
    } catch (err) {
      if (!this.docs.find(row.id)) return
      const stopped = this.core.stopped()
      if (err instanceof VmGone || (abort.signal.aborted && !stopped)) {
        if (err instanceof VmGone) this.core.set(row.id, { status: 'queued', progress: 0 })
        return
      }
      if (stopped) return
      const failure =
        err instanceof DocFailure ? err : new DocFailure('internal', errorMessage(err) || 'Unexpected error')
      if (!(err instanceof DocFailure))
        this.core.log('warn', 'knowledge document failed', { docId: row.id, err: errorMessage(err) })
      this.core.set(row.id, {
        status: 'failed',
        errorCode: failure.code,
        error: failure.message.slice(0, 500),
        progress: 0,
      })
    } finally {
      if (this.current?.abort === abort) this.current = null
    }
  }

  private alive(id: string, abort: AbortController): boolean {
    return !this.core.stopped() && !abort.signal.aborted && this.docs.find(id) !== null
  }

  /** Content of the document in `content.md`, then its chunks (searchable by text from here on). */
  private async extract(row: DocRow, signal: AbortSignal): Promise<void> {
    const dir = this.deps.workspaceDir
    if (row.source !== 'bot') {
      this.core.set(row.id, { status: 'extracting', progress: 0 })
      let current = this.docs.row(row.id)
      let original = originalPath(dir, row.id, current.file_name)
      if (!existsSync(original)) {
        await this.fetchOriginal(current)
        current = this.docs.row(row.id)
        original = originalPath(dir, row.id, current.file_name)
      }
      const bytes = await readFile(original)
      if (!bytes.length) throw new DocFailure('empty', 'The file is empty')
      let content: string
      let pages: number | null = null
      let ocrPages = 0
      if (needsVm(current.kind)) {
        if (bytes.length > MAX_EXTRACT_BYTES)
          throw new DocFailure('too_large', `Documents up to ${MAX_EXTRACT_BYTES / MB} MB can be read`)
        const extracted = await this.extractInVm(current, bytes, signal)
        ;({ content, pages, ocrPages } = extractedContent(extracted))
      } else {
        content = decodeText(bytes).replace(/\r\n?/g, '\n')
        if (current.kind === 'csv') pages = csvRows(content)
      }
      if (!stripPageMarkers(content).trim())
        throw new DocFailure('empty', 'No text was found in the document')
      if (signal.aborted || !this.docs.find(row.id)) return
      this.core.writeContent(row.id, content)
      this.docs.update(row.id, { pages, ocrPages }, false)
    }
    if (signal.aborted) return
    const content = this.core.readContent(row.id)
    if (content === null) throw new DocFailure('file_missing', 'The document content is missing')
    const kind = this.docs.row(row.id).kind
    const drafts = chunkContent(content, this.chunkOptions(kind))
    const oldIds = this.docs.chunks(row.id).map((c) => c.id)
    this.docs.replaceChunks(row.id, drafts)
    this.core.embeddings.forgetChunks(oldIds)
    this.core.embeddings.addStoredChunks(chunkRefs(this.docs.chunks(row.id)))
    this.core.set(row.id, { progress: 1 })
  }

  private async fetchOriginal(row: DocRow): Promise<void> {
    if (this.deps.vm.status().state !== 'running') throw new VmGone()
    const path =
      row.source === 'vm_file'
        ? row.source_ref
        : row.source === 'attachment' && row.source_ref
          ? this.attachmentPath(row.source_ref)
          : null
    if (!path) throw new DocFailure('file_missing', 'The file of this document is missing')
    const dir = docDir(this.deps.workspaceDir, row.id)
    mkdirSync(dir, { recursive: true })
    const temp = join(dir, 'original.partial')
    try {
      await readVmFile(this.deps.vm.runningGuest(), path, temp, this.deps.attachments.maxFileMb())
    } catch (err) {
      if (err instanceof DocFailure) throw err
      if (this.deps.vm.status().state !== 'running') throw new VmGone()
      throw err
    }
    const bytes = await readFile(temp)
    const kind = kindFor(row.file_name, bytes)
    await rename(temp, originalPath(this.deps.workspaceDir, row.id, row.file_name))
    this.docs.update(row.id, {
      kind,
      mime: mimeOf(kind, row.mime),
      bytes: bytes.length,
      sha256: sha256(bytes),
    })
  }

  private attachmentPath(id: string): string | null {
    try {
      const attachment = this.deps.attachments.get(id)
      const staged = this.deps.attachments.stagedFile(id)
      return staged ? null : attachment.path
    } catch {
      return null
    }
  }

  private async extractInVm(row: DocRow, bytes: Uint8Array, signal: AbortSignal) {
    if (this.deps.vm.status().state !== 'running') throw new VmGone()
    const sniffed = sniffFile(row.file_name, bytes.subarray(0, 64 * 1024))
    const legacy = sniffed.type === 'document' && isLegacyOfficeKind(sniffed.kind) ? sniffed.kind : null
    if (legacy && !this.core.legacyOffice().enabled)
      throw new DocFailure(
        'legacy_office_disabled',
        `Old Office file (.${legacy}): turn on "Old Office files" in Settings › Knowledge to read it`,
      )
    try {
      const kind = legacy ?? extractKindOf(row.kind)
      return await this.deps.vm.runningGuest().extract(bytes, {
        name: row.file_name,
        ...(kind ? { kind } : {}),
        signal,
      })
    } catch (err) {
      if (err instanceof GuestError && err.status !== 0) {
        const message =
          err.code === 'tools_missing'
            ? 'The VM is missing the document tools. Update the VM system, then reindex.'
            : err.code === 'office_missing'
              ? 'LibreOffice is not installed in the VM (its install failed or was removed). Try the install again in Settings › Knowledge.'
              : err.message
        throw new DocFailure(err.code, message)
      }
      if (this.deps.vm.status().state !== 'running' || signal.aborted) throw new VmGone()
      throw err
    }
  }

  chunkOptions(kind: KnowledgeKind) {
    const max = Math.max(64, Math.floor(this.core.embeddings.maxInputTokens() * 0.9))
    return {
      targetTokens: Math.min(DEFAULT_CHUNK_TOKENS, Math.floor(max * 0.85)),
      maxTokens: Math.min(Math.floor(DEFAULT_CHUNK_TOKENS * 1.5), max),
      csv: kind === 'csv',
      pageBreaks: PAGED_KINDS.has(kind),
    }
  }

  /** Cuts `content.md` into chunks again (vectors of unchanged chunks are kept); the embedding runs in the background. */
  rechunk(id: string, options: { summarizeIfChanged: boolean }): void {
    const row = this.docs.row(id)
    const content = this.core.readContent(id) ?? ''
    const before = new Set(this.docs.chunks(id).map((c) => c.sha256))
    const oldIds = this.docs.chunks(id).map((c) => c.id)
    const drafts = chunkContent(content, this.chunkOptions(row.kind))
    this.docs.replaceChunks(id, drafts)
    this.core.embeddings.forgetChunks(oldIds)
    this.core.embeddings.addStoredChunks(chunkRefs(this.docs.chunks(id)))
    if (options.summarizeIfChanged && row.status === 'ready') {
      const basis = new Set((row.summary_basis ?? '').split(',').filter(Boolean))
      const shas = drafts.map((d) => d.sha256.slice(0, 12))
      const changed =
        shas.filter((s) => !basis.has(s)).length + [...basis].filter((s) => !shas.includes(s)).length
      const ratio = changed / Math.max(1, Math.max(basis.size, shas.length))
      if (!row.summary || ratio >= SUMMARY_CHANGE_RATIO) {
        this.docs.update(id, { summaryStale: true }, false)
        this.scheduleSummary(id)
      }
    }
    const unchanged = drafts.every((d) => before.has(d.sha256)) && drafts.length === before.size
    if (row.status === 'ready' && !unchanged) {
      this.docs.update(id, { status: 'indexing', progress: 0 })
      this.pump()
    }
  }

  /** The document summary model of the knowledge settings. */
  private summaryModel(bot: Bot): Promise<ResolvedModel> {
    return createModelPolicy(this.deps.store, this.deps.catalog).knowledgeSummaryModel(bot)
  }

  private summaryInput(row: DocRow): string {
    const chunks = this.docs.chunks(row.id)
    const half = SUMMARY_INPUT_TOKENS / 2
    const head: string[] = []
    let used = 0
    let i = 0
    for (; i < chunks.length; i++) {
      const tokens = (chunks[i] as { tokens: number }).tokens
      if (used + tokens > half && head.length) break
      head.push((chunks[i] as { text: string }).text)
      used += tokens
    }
    const rest = chunks.slice(i)
    const samples: string[] = []
    if (rest.length) {
      const avg = Math.max(1, rest.reduce((s, c) => s + c.tokens, 0) / rest.length)
      const count = Math.min(rest.length, Math.max(1, Math.floor(half / avg)))
      const step = rest.length / count
      for (let k = 0; k < count; k++) samples.push((rest[Math.floor(k * step)] as { text: string }).text)
    }
    const body = [...head, ...(samples.length ? ['[…]', samples.join('\n[…]\n')] : [])].join('\n\n')
    const clipped =
      body.length > SUMMARY_INPUT_TOKENS * 3.5 ? body.slice(0, SUMMARY_INPUT_TOKENS * 3.5) : body
    return [
      `Title: ${row.title}`,
      `File: ${row.file_name} (${kindLabel(row)})`,
      '',
      '<document>',
      clipped,
      '</document>',
    ].join('\n')
  }

  /** Writes the summary; a failure (no model, provider error) leaves the document without one. */
  private async summarize(id: string, signal: AbortSignal): Promise<void> {
    const row = this.docs.row(id)
    if (!row.chunk_count) return
    const bot =
      (row.author_bot_id ? this.deps.store.bots.find(row.author_bot_id) : null) ??
      this.deps.store.bots.first()
    if (!bot) return
    this.core.set(id, { status: row.status === 'ready' ? 'ready' : 'summarizing', progress: 0 })
    try {
      const model = await this.summaryModel(bot)
      if (model.kind === 'unavailable') return
      if (model.kind === 'cli' && this.deps.vm.status().state !== 'running') {
        // CLI engines run in the VM: the summary is written once it is up.
        this.docs.update(id, { summaryStale: true }, false)
        return
      }
      const result = await this.deps.host.writeText({
        botId: bot.id,
        conversationId: null,
        purpose: 'knowledge_summary',
        system: SUMMARY_SYSTEM_PROMPT,
        prompt: this.summaryInput(row),
        maxOutputTokens: 400,
        signal,
        model,
      })
      const summary = cleanSummary(result.text)
      if (!summary || !this.docs.find(id)) return
      const modelName = model.model ?? null
      this.docs.update(id, {
        summary,
        summaryModel: modelName,
        summaryStale: false,
        summaryBasis: this.docs
          .chunks(id)
          .map((c) => c.sha256.slice(0, 12))
          .join(','),
      })
      this.core.changed(id)
    } catch (err) {
      if (signal.aborted) throw err
      this.core.log('warn', 'knowledge summary failed', { docId: id, err: errorMessage(err) })
    }
  }

  private scheduleSummary(id: string, delayMs = SUMMARY_DEBOUNCE_MS): void {
    const existing = this.summaryTimers.get(id)
    if (existing) clearTimeout(existing)
    const timer = setTimeout(() => {
      this.summaryTimers.delete(id)
      void this.resummarize(id)
    }, delayMs)
    timer.unref()
    this.summaryTimers.set(id, timer)
  }

  private async resummarize(id: string): Promise<void> {
    const row = this.docs.find(id)
    if (!row || this.core.stopped() || row.status !== 'ready') return
    await this.summarize(id, new AbortController().signal).catch(() => undefined)
    if (!this.docs.find(id)) return
    this.core.set(id, { status: 'ready' })
    await this.core.embeddings.refreshCorpus(SUMMARY_CORPUS, [id])
  }
}

function cleanSummary(text: string): string {
  const cleaned = text
    .trim()
    // Portuguese on purpose: a summary of a Portuguese document may start with "Resumo:".
    .replace(/^(summary|resumo)\s*:\s*/i, '')
    .replace(/^["“]|["”]$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return cleaned.length > 800 ? `${cleaned.slice(0, 799)}…` : cleaned
}
