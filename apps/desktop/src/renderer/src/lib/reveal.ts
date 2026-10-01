/*
 * Pacing for the typewriter reveal of streamed bot text. The speed depends on how far the reveal is
 * behind (the backlog): `REVEAL_BASE_CPS + backlog / tau`, with `tau` growing with the backlog
 * between REVEAL_MIN_TAU_MS and REVEAL_MAX_TAU_MS. Small backlogs (live streaming) are caught up
 * almost immediately, mid-sized ones sweep at a steady ~REVEAL_CATCH_UP_CPS and a whole long reply
 * arriving at once still finishes in about 1.5–2 s.
 */

const REVEAL_BASE_CPS = 80
const REVEAL_CATCH_UP_CPS = 1000
const REVEAL_MIN_TAU_MS = 200
const REVEAL_MAX_TAU_MS = 700
export const REVEAL_FADE_MS = 360
/** Frames longer than this (window hidden, debugger) do not jump further than this much time. */
const MAX_FRAME_MS = 250
const STEP_MS = 4
/** A trailing word still being streamed is held back unless it grows longer than this. */
const MAX_HELD_WORD = 40
/** Snapping to the end of a word never looks further ahead than this. */
const MAX_SNAP = 32

/** Characters per second while `backlog` characters are still hidden. */
function revealSpeed(backlog: number): number {
  const tau = Math.min(REVEAL_MAX_TAU_MS, Math.max(REVEAL_MIN_TAU_MS, (backlog / REVEAL_CATCH_UP_CPS) * 1000))
  return REVEAL_BASE_CPS + (backlog * 1000) / tau
}

/** Next (fractional) revealed length after `dtMs`, integrated in small steps so any frame rate paces alike. */
export function advanceReveal(shown: number, target: number, dtMs: number): number {
  let backlog = target - shown
  if (backlog <= 0) return target
  let left = Math.min(Math.max(dtMs, 0), MAX_FRAME_MS)
  while (left > 0 && backlog > 0) {
    const step = Math.min(STEP_MS, left)
    backlog -= (revealSpeed(backlog) * step) / 1000
    left -= step
  }
  return backlog <= 0 ? target : target - backlog
}

const isSpace = (ch: string | undefined) => ch !== undefined && /\s/.test(ch)

/** How much of `text` may be revealed: while streaming, a half-received trailing word waits. */
export function revealTarget(text: string, streaming: boolean): number {
  if (!streaming || text.length === 0 || isSpace(text[text.length - 1])) return text.length
  let start = text.length
  while (start > 0 && !isSpace(text[start - 1])) start--
  return text.length - start > MAX_HELD_WORD ? text.length : start
}

/** Moves `index` forward to the end of the word it falls in, so words appear whole. */
export function snapToWordEnd(text: string, index: number, limit = text.length): number {
  const end = Math.min(limit, text.length)
  if (index <= 0) return 0
  if (index >= end) return end
  if (isSpace(text[index - 1])) return index
  let i = index
  while (i < end && i - index < MAX_SNAP && !isSpace(text[i])) i++
  return i
}

/**
 * Closes inline markers left open by a cut in the middle of the source (`**bold`, `` `code``) so
 * the partial markdown renders the same way the final text will. Open fenced code blocks are
 * already rendered as code by the parser and are left alone.
 */
export function closeDanglingMarkdown(source: string): string {
  const fences = source.split('\n').filter((line) => /^ {0,3}(```|~~~)/.test(line)).length
  if (fences % 2 === 1) return source
  const paragraphStart = source.lastIndexOf('\n\n') + 1
  let paragraph = source.slice(paragraphStart)
  let suffix = ''
  if ((paragraph.match(/`/g)?.length ?? 0) % 2 === 1) {
    suffix += '`'
    paragraph += '`'
  }
  const outsideCode = paragraph.replace(/`[^`]*`/g, '')
  if ((outsideCode.match(/\*\*/g)?.length ?? 0) % 2 === 1) {
    if (!suffix && /\*\*\s*$/.test(source)) return source.replace(/\*\*\s*$/, '')
    suffix += '**'
  }
  return source + suffix
}

/** A run of newly revealed text; it fades in for `REVEAL_FADE_MS` after `born` (performance.now()). */
export interface RevealChunk {
  start: number
  born: number
}

export function pruneChunks(chunks: RevealChunk[], now: number): RevealChunk[] {
  const fresh = chunks.filter((c) => now - c.born < REVEAL_FADE_MS)
  return fresh.length === chunks.length ? chunks : fresh
}

/** Messages whose text should type out: the ones still streaming, or created moments ago. */
export function shouldAnimateReveal(
  message: { authorType: string; createdAt: number; content: string },
  streaming: boolean,
  now: number,
): boolean {
  if (message.authorType !== 'bot') return false
  return streaming || now - message.createdAt < 4000
}
