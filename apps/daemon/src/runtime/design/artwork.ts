import type { ResolvedModel, WriteTextRequest } from '@milibot/agent'
import { DRAW_SYSTEM_PROMPT, drawPrompt } from '@milibot/agent/prompts'
import type { Bot, LogFn, WorkspaceEvent } from '@milibot/shared'

import { errorMessage } from '../../errors'
import type { DesignCompiler } from './compile'
import {
  artInfo,
  type DesignRow,
  type DesignStore,
  type FrameRow,
  lookOf,
  type RevisionAuthor,
} from './store'
import { extractSvg, partialSvg, sanitizeSvg } from './svg'
import { findTheme } from './tokens'

/** Per workspace; the rest queue. */
const MAX_RUNNING = 2
const JOB_TIMEOUT_MS = 10 * 60_000
const DRAFT_INTERVAL_MS = 250
/** Thinking plus a detailed SVG; the provider caps it at the model's limit. */
const MAX_OUTPUT_TOKENS = 32_000

export interface ArtworkDeps {
  store: DesignStore
  blobs: { put(bytes: Uint8Array, mediaType: string): Promise<string> }
  compiler: DesignCompiler
  writeText: (request: WriteTextRequest) => Promise<{ text: string; stopReason?: string }>
  saveFrame: (
    design: DesignRow,
    before: FrameRow | null,
    after: FrameRow,
    author: RevisionAuthor,
    summary: string | null,
  ) => FrameRow
  emitFrame: (designId: string, frame: FrameRow) => void
  emit: (event: WorkspaceEvent) => void
  redact: (text: string) => string
  now: () => number
  log?: LogFn
}

export interface DrawJob {
  frameId: string
  designId: string
  bot: Bot
  conversationId: string | null
  turnId: string | null
  model: ResolvedModel
  prompt: string
  size: { width: number; height: number }
  /** SVG of the drawing being redrawn. */
  previous?: string
}

interface Running extends DrawJob {
  controller: AbortController
  /** A stopped job never saves. */
  stopped: string | null
}

/** Draws `design_draw`'s art frames in the background; outlives the turn that started it. */
export class ArtworkGenerator {
  private readonly running = new Map<string, Running>()
  private readonly queue: Running[] = []
  private readonly notices = new Map<string, string[]>()
  private readonly tasks = new Set<Promise<void>>()

  constructor(private readonly deps: ArtworkDeps) {}

  start(job: DrawJob): void {
    this.stop((j) => j.frameId === job.frameId, 'redrawn')
    const entry: Running = { ...job, controller: new AbortController(), stopped: null }
    this.queue.push(entry)
    this.pump()
  }

  pendingFor(botId: string): number {
    return [...this.running.values(), ...this.queue].filter((j) => j.bot.id === botId).length
  }

  isDrawing(frameId: string): boolean {
    return this.running.has(frameId) || this.queue.some((j) => j.frameId === frameId)
  }

  abortFrame(frameId: string): void {
    this.stop((j) => j.frameId === frameId, 'deleted')
  }

  abortDesign(designId: string): void {
    this.stop((j) => j.designId === designId, 'deleted')
  }

  abortBot(botId: string): void {
    this.stop((j) => j.bot.id === botId, 'deleted')
    this.notices.delete(botId)
  }

  /** Stops every job and marks its drawing failed (after a crash, the startup sweep does it). */
  closeAll(): void {
    this.deps.store.failInterruptedArt()
    this.stop(() => true, 'stopped')
  }

  takeNotices(botId: string): string[] {
    const lines = this.notices.get(botId) ?? []
    this.notices.delete(botId)
    return lines
  }

  /** For tests. */
  async idle(): Promise<void> {
    while (this.tasks.size) await Promise.all([...this.tasks])
  }

  private stop(match: (job: Running) => boolean, reason: string): void {
    for (let i = this.queue.length - 1; i >= 0; i--)
      if (match(this.queue[i] as Running)) this.queue.splice(i, 1)
    for (const job of this.running.values())
      if (match(job)) {
        job.stopped = reason
        job.controller.abort(new Error(reason))
      }
  }

  private pump(): void {
    while (this.running.size < MAX_RUNNING && this.queue.length) {
      const job = this.queue.shift() as Running
      this.running.set(job.frameId, job)
      const task = this.run(job)
        .catch((err: unknown) =>
          this.deps.log?.('warn', 'drawing failed unexpectedly', {
            frameId: job.frameId,
            err: errorMessage(err),
          }),
        )
        .finally(() => {
          if (this.running.get(job.frameId) === job) this.running.delete(job.frameId)
          this.tasks.delete(task)
          this.pump()
        })
      this.tasks.add(task)
    }
  }

  private async run(job: Running): Promise<void> {
    const timeout = setTimeout(() => job.controller.abort(new Error('timed out')), JOB_TIMEOUT_MS)
    timeout.unref?.()
    const draft = this.draftStream(job)
    let text: string
    let stopReason: string | undefined
    try {
      ;({ text, stopReason } = await this.deps.writeText({
        botId: job.bot.id,
        conversationId: job.conversationId,
        turnId: job.turnId,
        purpose: 'design_draw',
        label: 'draw',
        system: DRAW_SYSTEM_PROMPT,
        prompt: drawPrompt(job.size, job.prompt, job.previous),
        maxOutputTokens: MAX_OUTPUT_TOKENS,
        model: job.model,
        signal: job.controller.signal,
        onText: draft.push,
      }))
    } catch (err) {
      draft.end()
      if (job.stopped) return
      this.fail(job, job.controller.signal.aborted ? 'it took longer than 10 minutes' : errorMessage(err))
      return
    } finally {
      clearTimeout(timeout)
    }
    draft.end()
    if (job.stopped) return
    const markup = extractSvg(text)
    if (!markup) {
      const started = text.search(/<svg[\s>]/i) >= 0
      this.fail(
        job,
        stopReason === 'max_tokens'
          ? started
            ? 'the model ran out of output before finishing the SVG; ask for a simpler drawing'
            : 'the model spent its whole output limit reasoning and wrote no SVG; try once more with a shorter, simpler brief'
          : started
            ? 'the SVG was cut short'
            : 'the answer had no SVG',
      )
      return
    }
    const clean = sanitizeSvg(markup, job.size)
    if (!clean) {
      this.fail(job, 'the SVG had no shapes or was too large')
      return
    }
    const sha = await this.deps.blobs.put(new TextEncoder().encode(clean.svg), 'application/octet-stream')
    const current = this.current(job)
    if (!current) return
    const { design, frame } = current
    const info = artInfo(frame)
    const saved = this.deps.saveFrame(
      design,
      frame,
      {
        ...frame,
        html: `<img src="asset:${sha}" alt="${frame.name.replace(/[<>&"]/g, '')}" class="block size-full">`,
        art_status: 'ready',
        art_json: JSON.stringify({ ...info, error: null, finishedAt: this.deps.now() }),
      },
      { type: 'bot', botId: job.bot.id, turnId: job.turnId },
      `frame ${frame.name} drawn`,
    )
    this.touchReferencing(design.id, saved)
    this.notify(job.bot.id, `Drawing finished meanwhile: "${saved.name}" in "${design.name}" is ready.`)
  }

  /** Null when the frame is gone or no longer this job's drawing. */
  private current(job: Running): { design: DesignRow; frame: FrameRow } | null {
    const frame = this.deps.store.frame(job.frameId)
    const design = this.deps.store.row(job.designId)
    if (!frame || !design || frame.art_status !== 'drawing' || this.running.get(job.frameId) !== job)
      return null
    return { design, frame }
  }

  private fail(job: Running, reason: string): void {
    const current = this.current(job)
    if (!current) return
    const { design, frame } = current
    const error = this.deps.redact(reason).slice(0, 300)
    const info = artInfo(frame)
    const failed = this.deps.store.putFrame({
      ...frame,
      art_status: 'failed',
      art_json: JSON.stringify({ ...info, error, finishedAt: this.deps.now() }),
      updated_at: this.deps.now(),
    })
    this.deps.emitFrame(design.id, failed)
    this.touchReferencing(design.id, failed)
    this.notify(
      job.bot.id,
      `Drawing "${frame.name}" in "${design.name}" failed (${error}); draw it again once with design_draw.`,
    )
  }

  private notify(botId: string, line: string): void {
    this.notices.set(botId, [...(this.notices.get(botId) ?? []), line])
  }

  /** New `updated_at` (no revision) so the frames placing the art reload. */
  private touchReferencing(designId: string, art: FrameRow): void {
    const names = new Set([art.id, art.name].map((n) => n.toLowerCase()))
    for (const frame of this.deps.store.frames(designId)) {
      if (frame.id === art.id) continue
      const refs = [...frame.html.matchAll(/\bdata-art\s*=\s*(["'])(.*?)\1/gs)].map((m) =>
        (m[2] as string).trim().toLowerCase(),
      )
      if (!refs.some((r) => names.has(r))) continue
      this.deps.emitFrame(designId, this.deps.store.putFrame({ ...frame, updated_at: this.deps.now() }))
    }
  }

  private draftStream(job: Running): { push: (delta: string) => void; end: () => void } {
    const draftId = `art:${job.frameId}`
    let text = ''
    let shown = ''
    let last = 0
    let timer: NodeJS.Timeout | null = null
    let ended = false
    const emit = () => {
      timer = null
      if (ended || job.stopped) return
      const frame = this.deps.store.frame(job.frameId)
      const design = this.deps.store.row(job.designId)
      if (!frame || !design) return
      const partial = partialSvg(text, job.size)
      if (!partial || partial.svg === shown) return
      shown = partial.svg
      last = Date.now()
      const themes = lookOf(design).themes
      this.deps.emit({
        type: 'design.frame.draft',
        payload: {
          designId: design.id,
          draftId,
          botId: job.bot.id,
          frameId: frame.id,
          name: frame.name,
          x: frame.x,
          y: frame.y,
          width: frame.width,
          height: frame.height ?? job.size.height,
          theme: findTheme(themes, frame.theme ?? '') ?? themes[0] ?? 'default',
          html: this.deps.compiler.artDocument(partial.svg, frame.width, frame.height ?? job.size.height),
          art: { pen: partial.pen },
        },
      })
    }
    return {
      push: (delta) => {
        text += delta
        if (timer) return
        const wait = Math.max(0, DRAFT_INTERVAL_MS - (Date.now() - last))
        timer = setTimeout(emit, wait)
        timer.unref?.()
      },
      end: () => {
        ended = true
        if (timer) clearTimeout(timer)
        if (shown)
          this.deps.emit({ type: 'design.frame.draft.cleared', payload: { designId: job.designId, draftId } })
      },
    }
  }
}
