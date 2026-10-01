import type { ResolvedModel, ToolExecContext } from '@milibot/agent'
import {
  type Bot,
  DESIGN_LIMITS,
  firstOverlap,
  foldText,
  isPagedSize,
  nearestFreeSpot,
  newId,
  type WorkspaceEvent,
} from '@milibot/shared'

import { applyEdits } from '../code'
import type { DesignDrafts, FrameDraftInput, FrameDraftPayload } from './draft'
import { trimPartialHtml } from './draft'
import { artOnly } from './format'
import type { DesignHost } from './host'
import { assetRefs } from './html'
import type { DesignImages } from './images'
import type { LayoutChecks } from './layout'
import { autoPlace, FRAME_GAP } from './placement'
import { findFrame, resolveDesign } from './resolve'
import {
  AUTO_HEIGHT_GUESS,
  type DesignRow,
  type FrameRow,
  lookOf,
  placedFrames,
  type RevisionAuthor,
} from './store'
import { DesignInputError, findTheme, foldName } from './tokens'

/** Size of a draft whose call has not written its size yet, in a design without frames (desktop). */
const DRAFT_SIZE_GUESS = { width: 1440, height: 900 }
const PHONE_SIZE_GUESS = { width: 390, height: 844 }
// Portuguese on purpose: frame names are in the user's language ("celular" is a phone).
const PHONE_NAME = /\b(mobile|phone|iphone|android|celular)\b/
const MAX_DRAWINGS_PER_BOT = 3
const MAX_PREVIOUS_SVG = 120_000

export interface FrameSize {
  width: number
  height: number | null
}

export interface FrameWrite {
  name: string
  size: FrameSize
  html: string
  css: string
  /** The frame to replace (its name or id); '' replaces the frame of the same name, if any. */
  frame: string
  /** The theme's name ('' = the default); `keepTheme` keeps the replaced frame's when no theme was given. */
  theme: string | null
  keepTheme: boolean
  x: number | null
  y: number | null
}

export interface FrameDraw {
  name: string
  prompt: string
  size: { width: number; height: number }
  x: number | null
  y: number | null
}

export type MoveOutcome = { moved: true } | { moved: false; overlaps: string; free: { x: number; y: number } }

export interface DesignFramesDeps {
  host: DesignHost
  images: DesignImages
  layout: LayoutChecks
  drafts: () => DesignDrafts
  blobs: { get(sha: string): Promise<{ bytes: Uint8Array }> }
  emit: (event: WorkspaceEvent) => void
  /** The model `design_draw` draws with; absent: drawing is not available. */
  drawModel?: (bot: Bot, laneKey: string | undefined) => Promise<ResolvedModel>
}

export function botAuthor(ctx: Pick<ToolExecContext, 'bot' | 'turnId'>): RevisionAuthor {
  return { type: 'bot', botId: ctx.bot.id, turnId: ctx.turnId }
}

/** What bots do to frames: write, edit, draw, move, resize, rename, duplicate, delete, re-theme, reorder. */
export class DesignFrames {
  constructor(private readonly deps: DesignFramesDeps) {}

  private get store() {
    return this.deps.host.store
  }

  get canDraw(): boolean {
    return this.deps.host.artwork !== null && this.deps.drawModel !== undefined
  }

  /** Tells the canvas a bot is writing (or reading) a frame. */
  presence(
    ctx: ToolExecContext,
    designId: string,
    frameId: string | null,
    active: boolean,
    mode: 'write' | 'read' = 'write',
  ): void {
    this.deps.emit({
      type: 'design.presence',
      payload: { designId, frameId, botId: ctx.bot.id, active, mode },
    })
  }

  /** Tracks a `design_write_frame` call so its draft goes away once the frame is saved or the call fails. */
  draftCall(ctx: ToolExecContext, name: string): DraftCall {
    return new DraftCall(this.deps.drafts(), ctx, name)
  }

  async write(
    ctx: ToolExecContext,
    design: DesignRow,
    input: FrameWrite,
    call: DraftCall,
  ): Promise<{ saved: FrameRow; replaced: boolean; moved: string; check: string }> {
    const frames = this.store.frames(design.id)
    const target = findFrame(this.store, design, input.frame || input.name)
    if (target?.art_status) throw new DesignInputError(artOnly(target))
    const clash = frames.find((f) => f.id !== target?.id && foldName(f.name) === foldName(input.name))
    if (clash) throw new DesignInputError(`another frame is already named "${input.name}"`)
    if (!target && frames.length >= DESIGN_LIMITS.frames)
      throw new DesignInputError(`a design has at most ${DESIGN_LIMITS.frames} frames`)
    const frameId = target?.id ?? newId('designFrame')
    call.frameId = target?.id ?? null
    this.presence(ctx, design.id, frameId, true)
    try {
      const imported = await this.deps.images.import(input.html, input.css)
      const { size } = input
      const height = size.height ?? target?.measured_height ?? AUTO_HEIGHT_GUESS
      const others = placedFrames(frames).filter((f) => f.id !== frameId)
      let position: { x: number; y: number }
      let moved = ''
      if (input.x !== null || input.y !== null || target) {
        const wanted = {
          x: input.x ?? target?.x ?? 0,
          y: input.y ?? target?.y ?? 0,
          width: size.width,
          height,
        }
        position = nearestFreeSpot(wanted, others, frameId)
        if (position.x !== wanted.x || position.y !== wanted.y)
          moved = ` (it would overlap another frame at (${wanted.x}, ${wanted.y}), so it went to the nearest free spot)`
      } else position = autoPlace(others, { width: size.width, height })
      const saved = this.deps.host.saveFrame(
        design,
        target,
        {
          id: frameId,
          design_id: design.id,
          name: input.name,
          x: position.x,
          y: position.y,
          width: size.width,
          height: size.height,
          measured_height: size.height === null ? (target?.measured_height ?? null) : null,
          theme: input.theme ?? (input.keepTheme ? (target?.theme ?? null) : null),
          html: imported.html,
          css: imported.css,
          position: target?.position ?? frames.length,
          updated_at: this.deps.host.now(),
        },
        botAuthor(ctx),
        `frame ${input.name} ${target ? 'rewritten' : 'added'}`,
      )
      call.finish()
      const check = await this.deps.layout.checkWritten(
        this.store.row(design.id) as DesignRow,
        saved,
        ctx.signal,
        imported.problems,
      )
      return { saved: this.store.frame(saved.id) as FrameRow, replaced: target !== null, moved, check }
    } finally {
      this.presence(ctx, design.id, frameId, false)
    }
  }

  async edit(
    ctx: ToolExecContext,
    design: DesignRow,
    frame: FrameRow,
    edits: ReadonlyArray<{ oldText: string; newText: string }>,
    checkSource: (html: string, css: string) => void,
  ): Promise<string> {
    if (frame.art_status) throw new DesignInputError(artOnly(frame))
    const { html, css } = applyFrameEdits(frame.html, frame.css, edits)
    checkSource(html, css)
    this.presence(ctx, design.id, frame.id, true)
    try {
      const imported = await this.deps.images.import(html, css)
      const saved = this.deps.host.saveFrame(
        design,
        frame,
        { ...frame, html: imported.html, css: imported.css },
        botAuthor(ctx),
        `frame ${frame.name} edited`,
      )
      return await this.deps.layout.checkWritten(
        this.store.row(design.id) as DesignRow,
        saved,
        ctx.signal,
        imported.problems,
      )
    } finally {
      this.presence(ctx, design.id, frame.id, false)
    }
  }

  async draw(
    ctx: ToolExecContext,
    design: DesignRow,
    input: FrameDraw,
  ): Promise<{ saved: FrameRow; redrawn: boolean }> {
    const artwork = this.deps.host.artwork
    if (!artwork || !this.deps.drawModel)
      throw new DesignInputError('drawing is not available in this workspace')
    const { name, prompt } = input
    const { width, height } = input.size
    const frames = this.store.frames(design.id)
    const target = frames.find((f) => foldName(f.name) === foldName(name)) ?? null
    if (target && !target.art_status)
      throw new DesignInputError(`"${target.name}" is a frame of HTML; give the drawing another name`)
    if (target && artwork.isDrawing(target.id))
      throw new DesignInputError(
        `"${target.name}" is still being drawn; keep designing (design_read shows when it is done)`,
      )
    if (!target && frames.length >= DESIGN_LIMITS.frames)
      throw new DesignInputError(`a design has at most ${DESIGN_LIMITS.frames} frames`)
    if (artwork.pendingFor(ctx.bot.id) >= MAX_DRAWINGS_PER_BOT)
      throw new DesignInputError(
        `you already have ${MAX_DRAWINGS_PER_BOT} drawings in progress; keep designing and draw more once they finish`,
      )
    const model = await this.deps.drawModel(ctx.bot, ctx.laneKey)
    if (model.kind === 'unavailable')
      throw new DesignInputError(`there is no model to draw with: ${model.reason}`)
    const others = placedFrames(frames).filter((f) => f.id !== target?.id)
    const position =
      input.x !== null || input.y !== null || target
        ? nearestFreeSpot(
            { x: input.x ?? target?.x ?? 0, y: input.y ?? target?.y ?? 0, width, height },
            others,
          )
        : autoPlace(others, { width, height })
    const now = this.deps.host.now()
    const saved = this.deps.host.saveFrame(
      design,
      target,
      {
        id: target?.id ?? newId('designFrame'),
        design_id: design.id,
        name,
        x: position.x,
        y: position.y,
        width,
        height,
        measured_height: null,
        theme: target?.theme ?? null,
        html: target?.html ?? '',
        css: '',
        position: target?.position ?? frames.length,
        updated_at: now,
        art_status: 'drawing',
        art_json: JSON.stringify({
          prompt,
          botId: ctx.bot.id,
          error: null,
          startedAt: now,
          finishedAt: null,
        }),
      },
      botAuthor(ctx),
      `frame ${name} ${target ? 'redrawn' : 'drawn'}`,
    )
    const previous = await this.previousDrawing(target)
    artwork.start({
      frameId: saved.id,
      designId: design.id,
      bot: ctx.bot,
      conversationId: ctx.conversationId,
      turnId: ctx.turnId,
      model,
      prompt,
      size: { width, height },
      ...(previous ? { previous } : {}),
    })
    return { saved, redrawn: previous !== null }
  }

  private async previousDrawing(frame: FrameRow | null): Promise<string | null> {
    const sha = frame?.art_status ? assetRefs(frame.html)[0] : undefined
    if (!sha) return null
    try {
      const svg = Buffer.from((await this.deps.blobs.get(sha)).bytes).toString('utf8')
      return svg.length <= MAX_PREVIOUS_SVG ? svg : null
    } catch {
      return null
    }
  }

  move(ctx: ToolExecContext, design: DesignRow, frame: FrameRow, x: number, y: number): MoveOutcome {
    const others = this.others(design, frame)
    const rect = { x, y, width: frame.width, height: heightOf(frame) }
    const hit = firstOverlap(rect, others)
    if (hit)
      return {
        moved: false,
        overlaps: this.store.frame(hit.id)?.name ?? 'another frame',
        free: nearestFreeSpot(rect, others),
      }
    this.deps.host.saveFrame(design, frame, { ...frame, x, y }, botAuthor(ctx), `frame ${frame.name} moved`)
    return { moved: true }
  }

  async resize(
    ctx: ToolExecContext,
    design: DesignRow,
    frame: FrameRow,
    size: FrameSize,
  ): Promise<{ saved: FrameRow; spot: { x: number; y: number }; check: string }> {
    const rect = {
      x: frame.x,
      y: frame.y,
      width: size.width,
      height: size.height ?? frame.measured_height ?? AUTO_HEIGHT_GUESS,
    }
    const spot = nearestFreeSpot(rect, this.others(design, frame))
    const saved = this.deps.host.saveFrame(
      design,
      frame,
      { ...frame, ...size, ...spot, measured_height: size.height === null ? frame.measured_height : null },
      botAuthor(ctx),
      `frame ${frame.name} resized`,
    )
    const check = await this.deps.layout.check(this.store.row(design.id) as DesignRow, saved, ctx.signal)
    return { saved, spot, check: check.text }
  }

  /** Renames a frame; renaming a drawing also updates the `data-art` references to it (their count). */
  rename(ctx: ToolExecContext, design: DesignRow, frame: FrameRow, name: string): number {
    if (this.store.frames(design.id).some((f) => f.id !== frame.id && foldName(f.name) === foldName(name)))
      throw new DesignInputError(`another frame is already named "${name}"`)
    const author = botAuthor(ctx)
    this.deps.host.saveFrame(
      design,
      frame,
      { ...frame, name },
      author,
      `frame ${frame.name} renamed to ${name}`,
    )
    return frame.art_status ? this.renameArtRefs(design, frame.name, name, author) : 0
  }

  private renameArtRefs(design: DesignRow, from: string, to: string, author: RevisionAuthor): number {
    const pattern = new RegExp(
      `(\\bdata-art\\s*=\\s*)(["'])\\s*${from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\2`,
      'gi',
    )
    let changed = 0
    for (const frame of this.store.frames(design.id)) {
      if (frame.art_status) continue
      const html = frame.html.replace(
        pattern,
        (_m, head: string, quote: string) => `${head}${quote}${to}${quote}`,
      )
      if (html === frame.html) continue
      this.deps.host.saveFrame(
        design,
        frame,
        { ...frame, html },
        author,
        `frame ${frame.name}: art reference renamed`,
      )
      changed++
    }
    return changed
  }

  /** A copy beside the frame, named `wanted` or "<name> copy" (numbered while taken). */
  duplicate(ctx: ToolExecContext, design: DesignRow, frame: FrameRow, wanted: string): FrameRow {
    if (this.deps.host.artwork?.isDrawing(frame.id))
      throw new DesignInputError(`"${frame.name}" is still being drawn; duplicate it once it is ready`)
    const frames = this.store.frames(design.id)
    if (frames.length >= DESIGN_LIMITS.frames)
      throw new DesignInputError(`a design has at most ${DESIGN_LIMITS.frames} frames`)
    let name = wanted.slice(0, 80) || `${frame.name} copy`
    for (let n = 2; frames.some((f) => foldName(f.name) === foldName(name)); n++)
      name = `${wanted.slice(0, 70) || `${frame.name} copy`} ${n}`
    const spot = nearestFreeSpot(
      { x: frame.x + frame.width + FRAME_GAP, y: frame.y, width: frame.width, height: heightOf(frame) },
      placedFrames(frames),
      undefined,
      FRAME_GAP,
    )
    return this.deps.host.saveFrame(
      design,
      null,
      { ...frame, id: newId('designFrame'), name, ...spot, position: frame.position + 0.5 },
      botAuthor(ctx),
      `frame ${name} added (copy of ${frame.name})`,
    )
  }

  remove(ctx: ToolExecContext, design: DesignRow, frame: FrameRow): void {
    const { host } = this.deps
    host.artwork?.abortFrame(frame.id)
    this.store.deleteFrame(frame.id)
    host.revision(design.id, frame.id, botAuthor(ctx), `frame ${frame.name} deleted`, {
      kind: 'frame',
      before: frame,
      after: null,
    })
    host.emitFrame(design.id, frame, true)
    host.emitDesign(this.store.update(design.id, {}))
    host.scheduleThumbnail(design.id)
  }

  setTheme(ctx: ToolExecContext, design: DesignRow, frame: FrameRow, theme: string | null): void {
    this.deps.host.saveFrame(
      design,
      frame,
      { ...frame, theme },
      botAuthor(ctx),
      `frame ${frame.name} theme ${theme ?? 'default'}`,
    )
  }

  /** Moves a frame to `position` in the order; returns the frames' names in their new order. */
  reorder(ctx: ToolExecContext, design: DesignRow, frame: FrameRow, position: number): string[] {
    const { host } = this.deps
    this.store.reorder(design.id, frame.id, position)
    const saved = this.store.frame(frame.id) as FrameRow
    host.revision(design.id, frame.id, botAuthor(ctx), `frame ${frame.name} reordered`, {
      kind: 'frame',
      before: frame,
      after: saved,
    })
    for (const f of this.store.frames(design.id)) host.emitFrame(design.id, f)
    host.emitDesign(this.store.update(design.id, {}))
    host.scheduleThumbnail(design.id)
    return this.store.frames(design.id).map((f) => f.name)
  }

  private others(design: DesignRow, frame: FrameRow) {
    return placedFrames(this.store.frames(design.id)).filter((f) => f.id !== frame.id)
  }

  /**
   * What the canvas shows of a `design_write_frame` call still being written: the partial HTML compiled
   * where the frame will go. Null until the design, the name, the width and some HTML are known.
   */
  async prepareDraft(
    ctx: { bot: Bot; conversationId: string },
    input: FrameDraftInput,
  ): Promise<Omit<FrameDraftPayload, 'draftId' | 'botId'> | null> {
    if (!input.design || input.html === null) return null
    let design: DesignRow
    try {
      design = resolveDesign(this.store, ctx, input.design, true)
    } catch {
      return null
    }
    const name = (input.name ?? '').slice(0, 80)
    const look = lookOf(design)
    const theme = (input.theme ? findTheme(look.themes, input.theme) : null) ?? null
    const frames = this.store.frames(design.id)
    const target = findFrame(this.store, design, input.frame ?? name)
    if (target?.art_status) return null
    // Models may write the size after the HTML: until it arrives the draft takes the size of the frame it
    // replaces, else a phone's when the name says so, else the design's last frame's.
    const model =
      input.width === null
        ? (target ?? (PHONE_NAME.test(foldText(name)) ? PHONE_SIZE_GUESS : frames.at(-1)))
        : null
    const side = (value: number) => Math.min(Math.max(value, 16), DESIGN_LIMITS.frameSide)
    const width = side(input.width ?? model?.width ?? DRAFT_SIZE_GUESS.width)
    const rawHeight =
      input.height === undefined && input.width === null
        ? model
          ? model.height
          : DRAFT_SIZE_GUESS.height
        : input.height
    const height = rawHeight === null || rawHeight === undefined ? null : side(rawHeight)
    const others = placedFrames(frames).filter((f) => f.id !== target?.id)
    const guess = height ?? target?.measured_height ?? AUTO_HEIGHT_GUESS
    const position =
      input.x !== null || input.y !== null || target
        ? nearestFreeSpot(
            { x: input.x ?? target?.x ?? 0, y: input.y ?? target?.y ?? 0, width, height: guess },
            others,
            target?.id,
          )
        : autoPlace(others, { width, height: guess })
    const html = input.htmlComplete ? input.html : trimPartialHtml(input.html)
    const art = this.deps.host.artFor(design.id, html)
    const screen = height !== null && !isPagedSize(width, height)
    const compiled = await this.deps.host.compiler.compileDraft(look, {
      width,
      height: screen ? null : height,
      ...(screen ? { minHeight: height } : {}),
      theme: theme ?? (input.theme === null ? (target?.theme ?? null) : null),
      html,
      css: input.css ?? target?.css ?? '',
      ...(art ? { art } : {}),
    })
    return {
      designId: design.id,
      frameId: target?.id ?? null,
      name: name || target?.name || '',
      x: position.x,
      y: position.y,
      width,
      height,
      theme: compiled.theme,
      html: compiled.html,
    }
  }
}

export class DraftCall {
  designId: string | null = null
  frameId: string | null = null
  private done = false

  constructor(
    private readonly drafts: DesignDrafts,
    private readonly ctx: Pick<ToolExecContext, 'bot' | 'turnId'>,
    private readonly name: string,
  ) {}

  finish(): void {
    if (this.done) return
    this.done = true
    this.drafts.callFinished(
      { botId: this.ctx.bot.id, turnId: this.ctx.turnId },
      { designId: this.designId, frameId: this.frameId, name: this.name },
    )
  }
}

function heightOf(frame: FrameRow): number {
  return frame.height ?? frame.measured_height ?? AUTO_HEIGHT_GUESS
}

/**
 * Exact replacements over a frame's HTML, then its CSS: each old text must occur exactly once in one of them;
 * any failure leaves both unchanged.
 */
export function applyFrameEdits(
  html: string,
  css: string,
  edits: ReadonlyArray<{ oldText: string; newText: string }>,
): { html: string; css: string } {
  let nextHtml = html
  let nextCss = css
  edits.forEach((edit, i) => {
    const label = edits.length > 1 ? `edits[${i}]: ` : ''
    if (!edit.oldText) throw new DesignInputError(`${label}old_text is empty`)
    const inHtml = nextHtml.split(edit.oldText).length - 1
    const inCss = nextCss.split(edit.oldText).length - 1
    if (inHtml + inCss === 0)
      throw new DesignInputError(
        `${label}old_text was not found${i > 0 ? ' (after the previous edits)' : ''}; read the frame again (design_read with frame) and copy the exact text`,
      )
    if (inHtml + inCss > 1)
      throw new DesignInputError(
        `${label}old_text matches ${inHtml + inCss} times; include more of the surrounding text`,
      )
    const replace = { oldText: edit.oldText, newText: edit.newText, replaceAll: false }
    if (inHtml) nextHtml = applyEdits(nextHtml, [replace]).content
    else nextCss = applyEdits(nextCss, [replace]).content
  })
  return { html: nextHtml, css: nextCss }
}
