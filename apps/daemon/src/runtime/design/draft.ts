import type { ToolInputDraftContext } from '@milibot/agent'
import type { Bot, LogFn, WorkspaceEvent } from '@milibot/shared'

import { errorMessage } from '../../errors'
import { foldName } from './tokens'

/** A value of a JSON object read so far: complete, or a string cut before its closing quote. */
type PartialValue = { complete: true; value: unknown } | { complete: false; text: string }

const ESCAPES: Record<string, string> = {
  '"': '"',
  '\\': '\\',
  '/': '/',
  b: '\b',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t',
}

/**
 * Reads the JSON string starting at `start` (its opening quote). A string cut anywhere yields the text up to
 * the last complete escape (a lone high surrogate at the end is dropped).
 */
function readString(json: string, start: number): { text: string; end: number; complete: boolean } {
  const parts: string[] = []
  let i = start + 1
  let from = i
  for (;;) {
    const quote = json.indexOf('"', i)
    const slash = json.indexOf('\\', i)
    if (quote === -1 && slash === -1) {
      parts.push(json.slice(from))
      return { text: dropLoneSurrogate(parts.join('')), end: json.length, complete: false }
    }
    if (slash === -1 || (quote !== -1 && quote < slash)) {
      parts.push(json.slice(from, quote))
      return { text: parts.join(''), end: quote + 1, complete: true }
    }
    parts.push(json.slice(from, slash))
    const kind = json[slash + 1]
    if (kind === undefined)
      return { text: dropLoneSurrogate(parts.join('')), end: json.length, complete: false }
    if (kind === 'u') {
      const hex = json.slice(slash + 2, slash + 6)
      if (hex.length < 4)
        return { text: dropLoneSurrogate(parts.join('')), end: json.length, complete: false }
      parts.push(/^[0-9a-f]{4}$/i.test(hex) ? String.fromCharCode(parseInt(hex, 16)) : '')
      i = slash + 6
    } else {
      parts.push(ESCAPES[kind] ?? kind)
      i = slash + 2
    }
    from = i
  }
}

function dropLoneSurrogate(text: string): string {
  const last = text.charCodeAt(text.length - 1)
  return last >= 0xd800 && last <= 0xdbff ? text.slice(0, -1) : text
}

const skipSpace = (json: string, i: number) => {
  while (i < json.length && /\s/.test(json[i] as string)) i++
  return i
}

/** End of a nested object/array starting at `start`, or -1 when it is cut. */
function skipNested(json: string, start: number): number {
  let depth = 0
  let i = start
  while (i < json.length) {
    const c = json[i]
    if (c === '"') {
      const s = readString(json, i)
      if (!s.complete) return -1
      i = s.end
      continue
    }
    if (c === '{' || c === '[') depth++
    else if (c === '}' || c === ']') {
      depth--
      if (depth === 0) return i + 1
    }
    i++
  }
  return -1
}

/** The top-level keys of a JSON object that may be cut anywhere, in the order they were written. */
function parsePartialObject(json: string): Map<string, PartialValue> {
  const out = new Map<string, PartialValue>()
  let i = skipSpace(json, 0)
  if (json[i] !== '{') return out
  i++
  for (;;) {
    i = skipSpace(json, i)
    if (json[i] === ',') i = skipSpace(json, i + 1)
    if (json[i] !== '"') return out
    const key = readString(json, i)
    if (!key.complete) return out
    i = skipSpace(json, key.end)
    if (json[i] !== ':') return out
    i = skipSpace(json, i + 1)
    const c = json[i]
    if (c === undefined) return out
    if (c === '"') {
      const value = readString(json, i)
      out.set(
        key.text,
        value.complete ? { complete: true, value: value.text } : { complete: false, text: value.text },
      )
      if (!value.complete) return out
      i = value.end
    } else if (c === '{' || c === '[') {
      const end = skipNested(json, i)
      if (end === -1) return out
      try {
        out.set(key.text, { complete: true, value: JSON.parse(json.slice(i, end)) })
      } catch {
        return out
      }
      i = end
    } else {
      const match = /^[^,}\s]+/.exec(json.slice(i, i + 64))
      const token = match?.[0] ?? ''
      // A number at the very end may still grow ("12" of "120").
      if (!token || i + token.length >= json.length) return out
      try {
        out.set(key.text, { complete: true, value: JSON.parse(token) })
      } catch {
        return out
      }
      i += token.length
    }
  }
}

/** What a `design_write_frame` call being written tells so far. */
export interface FrameDraftInput {
  design: string | null
  frame: string | null
  name: string | null
  width: number | null
  /** Undefined: not written (yet); null: grows with the content. */
  height: number | null | undefined
  theme: string | null
  css: string | null
  x: number | null
  y: number | null
  /** The HTML written so far (null before its first character). */
  html: string | null
  htmlComplete: boolean
}

function asString(value: PartialValue | undefined): string | null {
  return value?.complete && typeof value.value === 'string' ? value.value.trim() || null : null
}

function asInt(value: PartialValue | undefined): number | null {
  if (!value?.complete) return null
  const raw = value.value
  if (typeof raw === 'number' && Number.isFinite(raw)) return Math.round(raw)
  if (typeof raw === 'string' && /^-?\d+$/.test(raw.trim())) return Number(raw.trim())
  return null
}

export function extractFrameDraft(partialJson: string): FrameDraftInput {
  const fields = parsePartialObject(partialJson)
  const html = fields.get('html')
  const height = fields.get('height')
  let heightValue: number | null | undefined
  if (height?.complete) {
    const raw = height.value
    heightValue = raw === null || raw === 'auto' || raw === 0 || raw === '0' ? null : asInt(height)
  }
  return {
    design: asString(fields.get('design')),
    frame: asString(fields.get('frame')),
    name: asString(fields.get('name')),
    width: asInt(fields.get('width')),
    height: heightValue,
    theme: asString(fields.get('theme')),
    css: fields.get('css')?.complete ? String((fields.get('css') as { value: unknown }).value ?? '') : null,
    x: asInt(fields.get('x')),
    y: asInt(fields.get('y')),
    html: html ? (html.complete ? (typeof html.value === 'string' ? html.value : null) : html.text) : null,
    htmlComplete: html?.complete ?? false,
  }
}

/**
 * Partial HTML without a tag or entity cut at its end (parse5 would show `<div cla` as text); open elements
 * are closed by the parser.
 */
export function trimPartialHtml(html: string): string {
  let out = html
  const open = out.lastIndexOf('<')
  if (open !== -1 && out.indexOf('>', open) === -1) out = out.slice(0, open)
  const amp = out.lastIndexOf('&')
  if (amp !== -1 && /^&[#a-z0-9]*$/i.test(out.slice(amp))) out = out.slice(0, amp)
  return out
}

export type FrameDraftPayload = Extract<WorkspaceEvent, { type: 'design.frame.draft' }>['payload']

/** The draft as the canvas shows it (without `draftId`/`botId`), or null while too little is known. */
export type PrepareDraft = (
  ctx: { bot: Bot; conversationId: string },
  input: FrameDraftInput,
) => Promise<Omit<FrameDraftPayload, 'draftId' | 'botId'> | null>

interface Draft {
  draftId: string
  key: string
  turnId: string
  botId: string
  ctx: ToolInputDraftContext
  json: string
  lastRun: number
  lastUpdate: number
  timer: NodeJS.Timeout | null
  running: boolean
  closed: boolean
  shown: FrameDraftPayload | null
}

const DRAFT_MIN_INTERVAL_MS = 500
/** A draft that stopped growing this long ago is dropped (the call was abandoned). */
const DRAFT_TTL_MS = 60_000

/**
 * Frames being written: compiles the partial input of `design_write_frame` at most every
 * `DRAFT_MIN_INTERVAL_MS` per call (always the latest input) and emits `design.frame.draft`; the draft goes
 * away (`design.frame.draft.cleared`) when the call finishes or the turn ends.
 */
export class DesignDrafts {
  /** By `key` (the call's id, or turn + sequence when the host gives none). */
  private readonly drafts = new Map<string, Draft>()
  private sequence = 0

  constructor(
    private readonly deps: {
      prepare: PrepareDraft
      emit: (event: WorkspaceEvent) => void
      log?: LogFn
      minIntervalMs?: number
    },
  ) {}

  update(ctx: ToolInputDraftContext, partialJson: string): void {
    this.expire()
    const draft = this.draftFor(ctx, partialJson)
    if (draft.closed) return
    draft.json = partialJson
    draft.lastUpdate = Date.now()
    this.schedule(draft)
  }

  private draftFor(ctx: ToolInputDraftContext, json: string): Draft {
    let key: string
    if (ctx.toolCallId) key = `${ctx.turnId}:${ctx.toolCallId}`
    else {
      // Without the call's id, the same call is the one whose input this one extends.
      const same = [...this.drafts.values()]
        .filter((d) => d.turnId === ctx.turnId && json.startsWith(d.json))
        .sort((a, b) => b.json.length - a.json.length)[0]
      key = same?.key ?? `${ctx.turnId}:${++this.sequence}`
    }
    let draft = this.drafts.get(key)
    if (!draft) {
      draft = {
        draftId: key,
        key,
        turnId: ctx.turnId,
        botId: ctx.bot.id,
        ctx,
        json: '',
        lastRun: 0,
        lastUpdate: Date.now(),
        timer: null,
        running: false,
        closed: false,
        shown: null,
      }
      this.drafts.set(key, draft)
    }
    return draft
  }

  private schedule(draft: Draft): void {
    if (draft.running || draft.timer || draft.closed) return
    const wait = Math.max(0, draft.lastRun + (this.deps.minIntervalMs ?? DRAFT_MIN_INTERVAL_MS) - Date.now())
    draft.timer = setTimeout(() => {
      draft.timer = null
      void this.run(draft)
    }, wait)
    draft.timer.unref?.()
  }

  private async run(draft: Draft): Promise<void> {
    if (draft.closed) return
    const json = draft.json
    draft.lastRun = Date.now()
    draft.running = true
    try {
      const prepared = await this.deps.prepare(
        { bot: draft.ctx.bot, conversationId: draft.ctx.conversationId },
        extractFrameDraft(json),
      )
      if (prepared && !draft.closed) {
        if (draft.shown && draft.shown.designId !== prepared.designId) this.emitCleared(draft)
        const payload: FrameDraftPayload = { ...prepared, draftId: draft.draftId, botId: draft.botId }
        if (!draft.shown || JSON.stringify(draft.shown) !== JSON.stringify(payload)) {
          draft.shown = payload
          this.deps.emit({ type: 'design.frame.draft', payload })
        }
      }
    } catch (err) {
      this.deps.log?.('info', 'design draft skipped', { err: errorMessage(err) })
    } finally {
      draft.running = false
      if (!draft.closed && draft.json !== json) this.schedule(draft)
    }
  }

  private emitCleared(draft: Draft): void {
    if (!draft.shown) return
    this.deps.emit({
      type: 'design.frame.draft.cleared',
      payload: { designId: draft.shown.designId, draftId: draft.draftId },
    })
    draft.shown = null
  }

  /** Closes a draft; its record stays until the turn ends so later input of the same call is ignored. */
  private close(draft: Draft): void {
    draft.closed = true
    if (draft.timer) clearTimeout(draft.timer)
    draft.timer = null
    this.emitCleared(draft)
  }

  /**
   * A `design_write_frame` call finished (written or failed): its draft goes away. Matched within the turn
   * (the bot's drafts when there is no turn) by the frame it replaced or its name, else the oldest one.
   */
  callFinished(
    call: { botId: string; turnId: string | null },
    frame: { designId: string | null; frameId: string | null; name: string },
  ): void {
    const open = [...this.drafts.values()].filter(
      (d) =>
        !d.closed &&
        (call.turnId ? d.turnId === call.turnId : d.botId === call.botId) &&
        (!frame.designId || !d.shown || d.shown.designId === frame.designId),
    )
    const key = foldName(frame.name)
    const match =
      open.find((d) => frame.frameId && d.shown?.frameId === frame.frameId) ??
      open.find((d) => d.shown && foldName(d.shown.name) === key) ??
      open.find((d) => !d.shown || !frame.designId || d.shown.designId === frame.designId)
    if (match) this.close(match)
  }

  turnEnded(turnId: string): void {
    for (const [key, draft] of this.drafts) {
      if (draft.turnId !== turnId) continue
      this.close(draft)
      this.drafts.delete(key)
    }
  }

  private expire(): void {
    const now = Date.now()
    for (const [key, draft] of this.drafts) {
      if (now - draft.lastUpdate < DRAFT_TTL_MS) continue
      this.close(draft)
      this.drafts.delete(key)
    }
  }

  closeAll(): void {
    for (const draft of this.drafts.values()) this.close(draft)
    this.drafts.clear()
  }
}
