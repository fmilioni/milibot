import { randomBytes } from 'node:crypto'

import type { BlobStore, NewAgentMessage, ToolExecContext, WriteTextRequest } from '@milibot/agent'
import {
  type Bot,
  type Design,
  DESIGN_FILE_EXTENSION,
  type DesignDetail,
  type designEndpoints,
  type DesignFrameHtml,
  type DesignFrameSource,
  type DesignPayload,
  type LogFn,
  type Message,
  type MessagePayload,
  nearestFreeSpot,
  newId,
  printDocument,
  type WorkspaceEvent,
} from '@milibot/shared'

import type { Db } from '../../db/sqlite'
import { DaemonError, errorMessage, notFound } from '../../errors'
import type { EndpointHandlers } from '../../handlers'
import { requireTarget } from '../../util/fs'
import { imageMediaType, isThumbnailable } from '../files'
import type { VmController } from '../vm'
import { ArtworkGenerator } from './artwork'
import type { DesignAssets } from './assets'
import { readDesignBundle, writeDesignBundle } from './bundle'
import { type DesignAsset, DesignCompiler } from './compile'
import { DesignDrafts } from './draft'
import { type FontFetch, FontLibrary } from './fonts'
import { botAuthor, DesignFrames, type DesignFramesDeps } from './frames'
import type { DesignHost } from './host'
import { type ArtRef, artRefs, assetRefs, sourceDocument } from './html'
import { DesignImages } from './images'
import { LayoutChecks } from './layout'
import { DesignOutput } from './output'
import type { DesignRenderBackend } from './render'
import { resolveDesign, resolveFrame } from './resolve'
import {
  AUTO_HEIGHT_GUESS,
  type DesignLook,
  type DesignRow,
  DesignStore,
  type FrameRow,
  lookOf,
  placedFrames,
  type RevisionAuthor,
  type RevisionSnapshot,
  toFrame,
} from './store'
import {
  applyTokenChanges,
  checkThemes,
  DesignInputError,
  findTheme,
  foldName,
  retheme,
  type TokenChange,
  tokensCss,
} from './tokens'

type DesignEndpoint = keyof typeof designEndpoints

const THUMBNAIL_WIDTH = 480
const THUMBNAIL_DELAY_MS = 1500

export interface DesignDeps {
  db: Db
  vm: Pick<VmController, 'guest'>
  blobs: BlobStore & { get(sha: string): Promise<{ mediaType: string; bytes: Uint8Array }> }
  render: DesignRenderBackend
  /** Base URL of the runtime's HTTP server as the renderer's Chrome reaches it (`http://10.0.2.2:<port>`). */
  renderBase: () => Promise<string>
  assets: DesignAssets | null
  fontsDir: string | null
  fontFetch?: FontFetch
  /** Downloads images named by http(s) URLs in frames (default: fetch). */
  imageFetch?: FontFetch
  /** Throws `not_found` for a conversation that does not exist. */
  assertConversation: (conversationId: string) => void
  appendMessage: (message: NewAgentMessage) => Message
  updateMessage: (id: string, patch: { content?: string; payload?: MessagePayload | null }) => Message
  emit: (event: WorkspaceEvent) => void
  now: () => number
  log?: LogFn
  /** `design_draw`'s side call and the model it draws with. */
  draw?: {
    writeText: (request: WriteTextRequest) => Promise<{ text: string }>
    model: NonNullable<DesignFramesDeps['drawModel']>
  }
  redact?: (text: string) => string
}

/**
 * Designs: their rows and revisions, the compiled frame documents (served to the renderer's Chrome through
 * the runtime's HTTP server, returned to the app as JSON), what the bots' `design_*` tools do and the chat card.
 */
export class DesignService implements DesignHost {
  readonly store: DesignStore
  /** Frames shown on the canvas while a bot is still writing them. */
  readonly drafts: DesignDrafts
  readonly compiler: DesignCompiler
  readonly fonts: FontLibrary
  /** Null without `deps.draw`. */
  readonly artwork: ArtworkGenerator | null
  readonly frames: DesignFrames
  readonly layout: LayoutChecks
  readonly output: DesignOutput
  private readonly tokens = new Map<string, string>()
  private readonly thumbnails = new Map<string, NodeJS.Timeout>()
  private pending = new Set<Promise<unknown>>()

  constructor(private readonly deps: DesignDeps) {
    this.store = new DesignStore(deps.db, deps.now)
    this.store.failInterruptedArt()
    this.fonts = new FontLibrary({
      dir: deps.fontsDir,
      assets: deps.assets,
      fetch: deps.fontFetch,
      now: deps.now,
      log: deps.log,
    })
    this.compiler = new DesignCompiler({
      assets: deps.assets,
      fonts: this.fonts,
      readAsset: (sha) => this.readAsset(sha),
    })
    this.drafts = new DesignDrafts({
      prepare: (ctx, input) => this.frames.prepareDraft(ctx, input),
      emit: deps.emit,
      log: deps.log,
    })
    this.artwork = deps.draw
      ? new ArtworkGenerator({
          store: this.store,
          blobs: deps.blobs,
          compiler: this.compiler,
          writeText: deps.draw.writeText,
          saveFrame: (design, before, after, author, summary) =>
            this.saveFrame(design, before, after, author, summary),
          emitFrame: (designId, frame) => this.emitFrame(designId, frame),
          emit: deps.emit,
          redact: deps.redact ?? ((text) => text),
          now: deps.now,
          log: deps.log,
        })
      : null
    this.layout = new LayoutChecks(this)
    this.frames = new DesignFrames({
      host: this,
      images: new DesignImages({ blobs: deps.blobs, vm: deps.vm, imageFetch: deps.imageFetch }),
      layout: this.layout,
      drafts: () => this.drafts,
      blobs: deps.blobs,
      emit: deps.emit,
      ...(deps.draw ? { drawModel: deps.draw.model } : {}),
    })
    this.output = new DesignOutput({ host: this, vm: deps.vm, blobs: deps.blobs })
  }

  get render(): DesignRenderBackend {
    return this.deps.render
  }

  now(): number {
    return this.deps.now()
  }

  /** Designs a board card can link to, newest first. */
  linkTargets(): Array<{ id: string; title: string }> {
    return this.store.linkTargets()
  }

  /** Blobs designs still show (images, drawings, thumbnails). */
  referencedBlobs(): Set<string> {
    return this.store.referencedBlobs()
  }

  /** A design a bot names (see `resolveDesign`). */
  resolve(ctx: Pick<ToolExecContext, 'bot' | 'conversationId'>, ref: string, write = false): DesignRow {
    return resolveDesign(this.store, ctx, ref, write)
  }

  resolveFrame(design: DesignRow, ref: string): FrameRow {
    return resolveFrame(this.store, design, ref)
  }

  /** Waits for background thumbnails (tests). */
  async idle(): Promise<void> {
    while (this.thumbnails.size || this.pending.size) {
      for (const [id, timer] of [...this.thumbnails]) {
        clearTimeout(timer)
        this.thumbnails.delete(id)
        this.track(this.refreshThumbnail(id))
      }
      await Promise.all([...this.pending])
      await this.artwork?.idle()
    }
  }

  async close(): Promise<void> {
    this.drafts.closeAll()
    this.artwork?.closeAll()
    for (const timer of this.thumbnails.values()) clearTimeout(timer)
    this.thumbnails.clear()
    await this.deps.render.close().catch(() => undefined)
  }

  track(promise: Promise<unknown>): void {
    const p = promise.catch((err: unknown) =>
      this.deps.log?.('warn', 'design background job failed', { err: errorMessage(err) }),
    )
    this.pending.add(p)
    void p.finally(() => this.pending.delete(p))
  }

  private async readAsset(sha: string): Promise<DesignAsset | null> {
    try {
      return await this.deps.blobs.get(sha)
    } catch {
      return null
    }
  }

  tokenFor(designId: string): string {
    let token = this.tokens.get(designId)
    if (!token) {
      token = randomBytes(24).toString('hex')
      this.tokens.set(designId, token)
    }
    return token
  }

  async printUrl(designId: string, frameIds: readonly string[]): Promise<string> {
    const base = await this.deps.renderBase()
    return `${base}/render/${this.tokenFor(designId)}/print?frames=${frameIds.join(',')}`
  }

  private designOfToken(token: string): string | null {
    for (const [designId, t] of this.tokens) if (t === token) return designId
    return null
  }

  async frameUrl(designId: string, frameId: string, theme: string | null): Promise<string> {
    const base = await this.deps.renderBase()
    const query = theme ? `?theme=${encodeURIComponent(theme)}` : ''
    return `${base}/render/${this.tokenFor(designId)}/${frameId}${query}`
  }

  compileRow(design: DesignRow, frame: FrameRow, theme?: string | null) {
    const art = this.artFor(design.id, frame.html)
    return this.compiler.compile(
      lookOf(design),
      {
        width: frame.width,
        height: frame.height,
        theme: frame.theme,
        html: frame.html,
        css: frame.css,
        ...(art ? { art } : {}),
      },
      theme ?? null,
    )
  }

  artFor(designId: string, html: string): Record<string, ArtRef | null> | undefined {
    const refs = artRefs(html)
    if (refs.length === 0) return undefined
    const frames = this.store.frames(designId).filter((f) => f.art_status)
    const out: Record<string, ArtRef | null> = {}
    for (const ref of refs) {
      const frame = frames.find((f) => f.id === ref) ?? frames.find((f) => foldName(f.name) === foldName(ref))
      out[ref] = frame ? artRef(frame) : null
    }
    return out
  }

  /**
   * `GET /render/<token>/<frameId>[?theme=]` (a frame's document) and `/render/<token>/print?frames=a,b`
   * (one page per frame) for the renderer's Chrome; the token is per design and per runtime.
   */
  async renderDocument(
    token: string,
    path: string,
    query: URLSearchParams,
  ): Promise<{ status: number; body: string } | null> {
    const designId = this.designOfToken(token)
    const design = designId ? this.store.row(designId) : null
    if (!design) return null
    const theme = query.get('theme')
    if (path === 'print') {
      const ids = (query.get('frames') ?? '').split(',').filter(Boolean)
      const frames = ids
        .map((id) => this.store.frame(id))
        .filter((f): f is FrameRow => f?.design_id === design.id)
      return { status: 200, body: this.printDocument(token, frames, theme) }
    }
    const frame = this.store.frame(path)
    if (!frame || frame.design_id !== design.id) return null
    return { status: 200, body: (await this.compileRow(design, frame, theme)).html }
  }

  private printDocument(token: string, frames: readonly FrameRow[], theme: string | null): string {
    const themeQuery = theme ? `?theme=${encodeURIComponent(theme)}` : ''
    return printDocument(
      frames.map((f) => ({ id: f.id, width: f.width, height: f.height, measuredHeight: f.measured_height })),
      (f) => `src="/render/${token}/${f.id}${themeQuery}"`,
      `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src 'self'; style-src 'unsafe-inline'">`,
    )
  }

  private design(row: DesignRow): Design {
    return this.store.toDesign(row)
  }

  private detail(row: DesignRow): DesignDetail {
    return { ...this.design(row), frames: this.store.frames(row.id).map(toFrame) }
  }

  private requireDesign(id: string): DesignRow {
    const row = this.store.row(id)
    if (!row) throw notFound('design', id)
    return row
  }

  private requireFrame(design: DesignRow, frameId: string): FrameRow {
    const frame = this.store.frame(frameId)
    if (!frame || frame.design_id !== design.id) throw notFound('frame', frameId)
    return frame
  }

  emitDesign(row: DesignRow): Design {
    const design = this.design(row)
    this.deps.emit({ type: 'design.updated', payload: { design } })
    this.updateCard(row)
    return design
  }

  emitFrame(designId: string, frame: FrameRow, deleted = false): void {
    this.deps.emit({ type: 'design.frame.updated', payload: { designId, frame: toFrame(frame), deleted } })
  }

  cardPayload(row: DesignRow, removed = false): DesignPayload {
    return {
      type: 'design',
      designId: row.id,
      botId: row.bot_id ?? '',
      name: row.name,
      frameCount: this.store.frames(row.id).length,
      thumbnailSha: row.thumbnail_sha,
      ...(row.archived_at !== null ? { archived: true } : {}),
      ...(removed ? { removed: true } : {}),
    }
  }

  private updateCard(row: DesignRow, removed = false): void {
    if (!row.message_id) return
    try {
      this.deps.updateMessage(row.message_id, {
        content: `Design: ${row.name}`,
        payload: this.cardPayload(row, removed),
      })
    } catch (err) {
      this.deps.log?.('warn', 'design card update failed', { designId: row.id, err: errorMessage(err) })
    }
  }

  scheduleThumbnail(designId: string): void {
    const existing = this.thumbnails.get(designId)
    if (existing) clearTimeout(existing)
    const timer = setTimeout(() => {
      this.thumbnails.delete(designId)
      this.track(this.refreshThumbnail(designId))
    }, THUMBNAIL_DELAY_MS)
    timer.unref?.()
    this.thumbnails.set(designId, timer)
  }

  private async refreshThumbnail(designId: string): Promise<void> {
    if (!this.deps.render.available()) return
    const row = this.store.row(designId)
    const first = row ? this.store.frames(designId)[0] : undefined
    if (!row || !first) return
    const scale = Math.min(1, THUMBNAIL_WIDTH / first.width)
    const result = await this.deps.render.render({
      url: await this.frameUrl(designId, first.id, null),
      width: first.width,
      height:
        first.height ?? (first.measured_height ? Math.min(first.measured_height, first.width * 2) : null),
      scale,
      screenshot: true,
    })
    if (!result.png) return
    const sha = await this.deps.blobs.put(result.png, 'image/png')
    const latest = this.store.row(designId)
    if (!latest || latest.thumbnail_sha === sha) return
    this.emitDesign(this.store.update(designId, { thumbnail_sha: sha, updated_at: latest.updated_at }))
  }

  revision(
    designId: string,
    frameId: string | null,
    author: RevisionAuthor,
    summary: string,
    snapshot: RevisionSnapshot,
  ): void {
    this.store.addRevision(designId, frameId, author, summary, snapshot)
  }

  handlers(): EndpointHandlers<DesignEndpoint> {
    return {
      listDesigns: ({ query }) => this.store.rows(query).map((r) => this.design(r)),
      getDesign: ({ params }) => this.detail(this.requireDesign(params.designId)),
      getDesignFrameHtml: async ({ params, query }): Promise<DesignFrameHtml> => {
        const design = this.requireDesign(params.designId)
        const frame = this.requireFrame(design, params.frameId)
        const compiled = await this.compileRow(design, frame, query.theme ?? null)
        return {
          frameId: frame.id,
          theme: compiled.theme,
          width: frame.width,
          height: frame.height,
          html: compiled.html,
          problems: compiled.problems,
        }
      },
      getDesignFrameSource: async ({ params }): Promise<DesignFrameSource> => {
        const design = this.requireDesign(params.designId)
        const frame = this.requireFrame(design, params.frameId)
        const look = lookOf(design)
        const compiled = await this.compileRow(design, frame)
        return {
          frameId: frame.id,
          name: frame.name,
          theme: compiled.theme,
          html: compiled.html,
          source: sourceDocument(design, frame, compiled.theme),
          tokensCss: tokensCss(design.name, look.tokens, look.themes),
        }
      },
      moveDesignFrame: ({ params, body }) => {
        const design = this.requireDesign(params.designId)
        const frame = this.requireFrame(design, params.frameId)
        const spot = nearestFreeSpot(
          {
            x: body.x,
            y: body.y,
            width: frame.width,
            height: frame.height ?? frame.measured_height ?? AUTO_HEIGHT_GUESS,
          },
          placedFrames(this.store.frames(design.id)),
          frame.id,
        )
        return toFrame(this.saveFrame(design, frame, { ...frame, ...spot }, USER, null))
      },
      updateDesignTokens: ({ params, body }) => this.userTokens(params.designId, body.values),
      listDesignRevisions: ({ params }) => {
        this.requireDesign(params.designId)
        return this.store.revisions(params.designId)
      },
      restoreDesignRevision: ({ params, body }) =>
        this.restore(params.designId, params.revisionId, body?.undo === true),
      archiveDesign: ({ params, body }) => this.archiveDesign(params.designId, body.archived),
      renameDesign: ({ params, body }) => this.renameDesign(params.designId, body.name),
      deleteDesign: ({ params }) => {
        this.deleteDesign(params.designId)
        return { ok: true as const }
      },
      exportDesign: async ({ params, body }) => {
        await this.exportFile(params.designId, body.path, body.frameIds)
        return { ok: true as const }
      },
      importDesign: ({ body }) => this.importFile(body.path, body.conversationId),
    }
  }

  /** A new design and its chat card (a bot's `design_create`, or an imported file). */
  createDesign(input: {
    look: DesignLook
    conversationId: string
    bot: Bot | null
    turnId: string | null
  }): DesignRow {
    const { name, ...look } = input.look
    let row = this.store.insert({
      name,
      conversationId: input.conversationId,
      botId: input.bot?.id ?? null,
      look,
    })
    const message = this.deps.appendMessage({
      conversationId: input.conversationId,
      authorType: input.bot ? 'bot' : 'system',
      authorBotId: input.bot?.id ?? null,
      kind: 'card',
      content: `Design: ${name}`,
      payload: this.cardPayload(row),
      turnId: input.turnId,
    })
    row = this.store.update(row.id, { message_id: message.id, updated_at: row.updated_at })
    // Downloads the fonts now, not during the first frame's layout check.
    if (look.fonts.length) this.track(this.fonts.css(look.fonts, ''))
    return row
  }

  private async exportFile(designId: string, path: string, frameIds?: string[]): Promise<void> {
    const design = this.requireDesign(designId)
    requireTarget(path, `.${DESIGN_FILE_EXTENSION}`)
    const frames = frameIds
      ? frameIds.map((id) => this.requireFrame(design, id))
      : this.store.frames(designId)
    await writeDesignBundle(
      path,
      design,
      frames,
      async (sha) => (await this.readAsset(sha))?.bytes ?? null,
      this.deps.now(),
    )
  }

  private async importFile(path: string, conversationId: string): Promise<Design> {
    this.deps.assertConversation(conversationId)
    const bundle = await readDesignBundle(path)
    for (const bytes of bundle.assets.values()) {
      const type = imageMediaType(bytes, { svg: true })
      if (!type) continue
      await this.deps.blobs.put(bytes, isThumbnailable(type) ? type : 'application/octet-stream')
    }
    const { content } = bundle
    const taken = new Set(this.store.rows({ archived: true }).map((r) => foldName(r.name)))
    let name = content.name
    for (let n = 2; taken.has(foldName(name)); n++) name = `${content.name} (${n})`
    const row = this.createDesign({
      look: { name, themes: content.themes, tokens: content.tokens, fonts: content.fonts },
      conversationId,
      bot: null,
      turnId: null,
    })
    const placed: ReturnType<typeof placedFrames> = []
    for (const [i, frame] of content.frames.entries()) {
      const source = bundle.sources[i] as { html: string; css: string }
      const id = newId('designFrame')
      const height = frame.height ?? AUTO_HEIGHT_GUESS
      const spot = nearestFreeSpot({ x: frame.x, y: frame.y, width: frame.width, height }, placed, id)
      placed.push({ id, ...spot, width: frame.width, height })
      this.store.putFrame({
        id,
        design_id: row.id,
        name: frame.name,
        ...spot,
        width: frame.width,
        height: frame.height,
        measured_height: null,
        theme: frame.theme,
        html: source.html,
        css: source.css,
        position: i,
        updated_at: this.deps.now(),
        ...(frame.art && assetShaOf(source.html)
          ? {
              art_status: 'ready' as const,
              art_json: JSON.stringify({
                prompt: frame.art.prompt,
                botId: null,
                error: null,
                startedAt: this.deps.now(),
                finishedAt: this.deps.now(),
              }),
            }
          : {}),
      })
    }
    this.scheduleThumbnail(row.id)
    return this.emitDesign(this.store.update(row.id, {}))
  }

  private userTokens(designId: string, values: Record<string, Record<string, string | number>>): Design {
    const row = this.requireDesign(designId)
    const before = lookOf(row)
    const tokens = before.tokens.map((t) => ({ ...t, values: { ...t.values } }))
    const changed: string[] = []
    try {
      for (const [name, perTheme] of Object.entries(values)) {
        const token = tokens.find((t) => t.name === name)
        if (!token)
          throw new DaemonError('validation_failed', `unknown token: ${name}`, { reason: 'unknown_token' })
        for (const [themeName, value] of Object.entries(perTheme)) {
          if (themeName === '*') {
            const merged = applyTokenChanges([token], [{ name, value }], before.themes).tokens[0]
            if (merged) Object.assign(token, merged)
            continue
          }
          const theme = findTheme(before.themes, themeName)
          if (!theme)
            throw new DaemonError('validation_failed', `unknown theme: ${themeName}`, {
              reason: 'unknown_theme',
            })
          const merged = applyTokenChanges([token], [{ name, values: { [theme]: value } }], before.themes)
            .tokens[0]
          if (merged) Object.assign(token, merged)
        }
        changed.push(name)
      }
    } catch (err) {
      if (err instanceof DesignInputError)
        throw new DaemonError('validation_failed', err.message, { reason: 'invalid_value' })
      throw err
    }
    const after: DesignLook = { ...before, tokens }
    const saved = this.store.setLook(designId, after)
    this.revision(designId, null, USER, `tokens: ${changed.join(', ')}`, { kind: 'look', before, after })
    this.scheduleThumbnail(designId)
    return this.emitDesign(saved)
  }

  /**
   * A bot's change of the look: themes renamed (`renames`, old → new) or replaced (`themes`), token changes and
   * fonts; frames on a renamed theme follow it, those on a theme that is gone go back to the default.
   */
  changeLook(
    ctx: ToolExecContext,
    design: DesignRow,
    input: {
      renames: Array<[string, string]>
      themes: string[] | null
      tokens: TokenChange[]
      fonts: string[] | null
    },
  ): { after: DesignLook; changed: string[] } {
    const before = lookOf(design)
    let themes = [...before.themes]
    const renamed = new Map<string, string>()
    if (input.renames.length) {
      for (const [from, to] of input.renames) {
        const theme = findTheme(themes, from)
        if (!theme) throw new DesignInputError(`there is no theme "${from}" (themes: ${themes.join(', ')})`)
        renamed.set(theme, to)
        themes = themes.map((t) => (t === theme ? to : t))
      }
      themes = checkThemes(themes)
    }
    if (input.themes) themes = input.themes
    const merged = applyTokenChanges(retheme(before.tokens, themes, renamed), input.tokens, themes)
    const fonts = input.fonts ?? before.fonts
    const after: DesignLook = { ...before, themes, tokens: merged.tokens, fonts }
    this.store.setLook(design.id, after)
    for (const frame of this.store.frames(design.id)) {
      const theme = frame.theme ? (renamed.get(frame.theme) ?? frame.theme) : null
      const next = theme && themes.includes(theme) ? theme : null
      if (next !== frame.theme) this.emitFrame(design.id, this.store.putFrame({ ...frame, theme: next }))
    }
    const changed = [
      themes.join() !== before.themes.join() ? `themes ${themes.join(', ')}` : '',
      merged.changed.length ? `tokens ${merged.changed.join(', ')}` : '',
      fonts.join() !== before.fonts.join() ? `fonts ${fonts.join(', ') || 'none'}` : '',
    ].filter(Boolean)
    this.revision(design.id, null, botAuthor(ctx), changed.join('; ') || 'no change', {
      kind: 'look',
      before,
      after,
    })
    this.emitDesign(this.store.row(design.id) as DesignRow)
    this.scheduleThumbnail(design.id)
    return { after, changed }
  }

  /** Back to the state a revision saved, or (`undo`) to the state before it. */
  private restore(designId: string, revisionId: string, undo = false): DesignDetail {
    const row = this.requireDesign(designId)
    const revision = this.store.revision(designId, revisionId)
    if (!revision) throw notFound('revision', revisionId)
    const snapshot = revision.snapshot
    if (snapshot.kind === 'look') {
      const before = lookOf(row)
      const target = undo ? snapshot.before : snapshot.after
      const saved = this.store.setLook(designId, target)
      this.revision(designId, null, USER, undo ? `undid ${revision.summary}` : 'restored tokens', {
        kind: 'look',
        before,
        after: target,
      })
      this.emitDesign(saved)
    } else {
      if (undo && !snapshot.before)
        throw new DaemonError('conflict', 'the frame did not exist before this revision', {
          reason: 'nothing_to_undo',
        })
      const saved = undo ? snapshot.before : (snapshot.after ?? snapshot.before)
      // A drawing restored mid-way has no job left to finish it.
      const target =
        saved?.art_status === 'drawing' && !this.artwork?.isDrawing(saved.id)
          ? { ...saved, art_status: assetShaOf(saved.html) ? ('ready' as const) : ('failed' as const) }
          : saved
      if (target) {
        const current = this.store.frame(target.id)
        const frames = placedFrames(this.store.frames(designId))
        const spot = current
          ? { x: target.x, y: target.y }
          : nearestFreeSpot(
              { ...target, height: target.height ?? target.measured_height ?? AUTO_HEIGHT_GUESS },
              frames,
              target.id,
            )
        this.saveFrame(
          row,
          current,
          {
            ...target,
            ...spot,
            position: current?.position ?? this.store.frames(designId).length,
          },
          USER,
          `frame ${target.name} restored`,
        )
      }
    }
    this.scheduleThumbnail(designId)
    return this.detail(this.requireDesign(designId))
  }

  archiveDesign(designId: string, archived: boolean): Design {
    const row = this.requireDesign(designId)
    if ((row.archived_at !== null) === archived) return this.design(row)
    return this.emitDesign(
      this.store.update(designId, {
        archived_at: archived ? this.deps.now() : null,
        updated_at: row.updated_at,
      }),
    )
  }

  renameDesign(designId: string, name: string): Design {
    const row = this.requireDesign(designId)
    if (row.name === name) return this.design(row)
    return this.emitDesign(this.store.update(designId, { name }))
  }

  deleteDesign(designId: string): void {
    const row = this.requireDesign(designId)
    this.artwork?.abortDesign(designId)
    this.store.delete(designId)
    this.tokens.delete(designId)
    const timer = this.thumbnails.get(designId)
    if (timer) clearTimeout(timer)
    this.thumbnails.delete(designId)
    this.updateCard(row, true)
    this.deps.emit({ type: 'design.deleted', payload: { designId } })
  }

  /** Saves a frame (new or changed), records the revision and announces it. */
  saveFrame(
    design: DesignRow,
    before: FrameRow | null,
    after: FrameRow,
    author: RevisionAuthor,
    /** Null: no revision (the user dragging a frame around). */
    summary: string | null,
  ): FrameRow {
    const saved = this.store.putFrame({ ...after, updated_at: this.deps.now() })
    this.store.renumber(design.id)
    const latest = this.store.frame(saved.id) as FrameRow
    if (summary !== null)
      this.revision(design.id, latest.id, author, summary, { kind: 'frame', before, after: latest })
    const designRow = this.store.update(design.id, {})
    this.emitFrame(design.id, latest)
    this.emitDesign(designRow)
    if (latest.position === 0 || before?.position === 0) this.scheduleThumbnail(design.id)
    return latest
  }
}

const USER: RevisionAuthor = { type: 'user', botId: null, turnId: null }

function assetShaOf(html: string): string | null {
  return assetRefs(html)[0] ?? null
}

/** The last good drawing still shows while it is redrawn or after a redraw failed. */
function artRef(frame: FrameRow): ArtRef {
  const size = { width: frame.width, height: frame.height ?? frame.measured_height ?? frame.width }
  const sha = assetShaOf(frame.html)
  if (sha) return { status: 'ready', sha, ...size }
  return { status: frame.art_status === 'failed' ? 'failed' : 'drawing', ...size }
}
