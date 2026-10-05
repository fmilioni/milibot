import {
  type Board,
  BOARD_CARD_STATUSES,
  BOARD_USER,
  type BoardCard,
  type BoardCardLink,
  type BoardCardStatus,
  type BoardCounts,
  type BoardLabel,
  columnCards,
  foldText,
} from '@milibot/shared'

import type { Tone } from '@/lib/tone'

export type BoardFilter = 'active' | 'done' | 'archived'

export const CARD_TONE: Record<BoardCardStatus, Tone> = {
  todo: 'muted',
  doing: 'accent',
  done: 'success',
  dropped: 'danger',
}

export const COLUMN_PREFIX = 'column:'

export function boardsIn(boards: readonly Board[], filter: BoardFilter): Board[] {
  return boards.filter((b) =>
    filter === 'archived' ? b.archivedAt !== null : b.archivedAt === null && b.status === filter,
  )
}

/** Done cards over the cards that count (dropped ones do not). */
export function boardProgress(counts: BoardCounts): { done: number; total: number } {
  return { done: counts.done, total: counts.todo + counts.doing + counts.done }
}

/**
 * Where a dragged card lands: the column and index of the card it is over (its place in that column as it is
 * now), or the end of a column it is over.
 */
export function dropPlace(
  cards: readonly { id: string; status: BoardCardStatus; position: number }[],
  overId: string,
): { status: BoardCardStatus; index: number } | null {
  if (overId.startsWith(COLUMN_PREFIX)) {
    const status = overId.slice(COLUMN_PREFIX.length) as BoardCardStatus
    if (!BOARD_CARD_STATUSES.includes(status)) return null
    return { status, index: columnCards(cards, status).length }
  }
  const over = cards.find((c) => c.id === overId)
  if (!over) return null
  return { status: over.status, index: columnCards(cards, over.status).findIndex((c) => c.id === overId) }
}

/** `text` with `insert` at the caret (on its own line when the caret is mid-line). */
export function insertAtCaret(text: string, caret: number, insert: string): { text: string; caret: number } {
  const at = Math.max(0, Math.min(caret, text.length))
  const before = text.slice(0, at)
  const after = text.slice(at)
  const lead = before && !before.endsWith('\n') ? '\n' : ''
  const trail = after && !after.startsWith('\n') ? '\n' : ''
  const piece = `${lead}${insert}${trail}`
  return { text: before + piece + after, caret: at + piece.length }
}

/** What the user narrows a board to; kept per board while the app runs, never saved. */
export interface CardFilters {
  /** Matches titles, summaries and label names. */
  text: string
  /** Cards with any of these assignees (bot ids, `BOARD_USER`). */
  assignees: string[]
  /** Cards with any of these labels. */
  labels: string[]
  /** Only cards the user is on. */
  mine: boolean
}

export const NO_FILTERS: CardFilters = { text: '', assignees: [], labels: [], mine: false }

/** How many filters are on (the text counts once). */
export function activeFilterCount(filters: CardFilters): number {
  return (
    (filters.text.trim() ? 1 : 0) +
    (filters.assignees.length ? 1 : 0) +
    (filters.labels.length ? 1 : 0) +
    (filters.mine ? 1 : 0)
  )
}

/** The cards that pass every filter on, in the order given. */
export function filterCards<T extends Pick<BoardCard, 'title' | 'summary' | 'labelIds' | 'assignees'>>(
  cards: readonly T[],
  filters: CardFilters,
  labels: readonly BoardLabel[],
): T[] {
  if (!activeFilterCount(filters)) return [...cards]
  const words = foldText(filters.text, { trim: true }).split(/\s+/).filter(Boolean)
  const names = new Map(labels.map((l) => [l.id, l.name]))
  return cards.filter((card) => {
    if (filters.mine && !card.assignees.includes(BOARD_USER)) return false
    if (filters.assignees.length && !card.assignees.some((a) => filters.assignees.includes(a))) return false
    if (filters.labels.length && !card.labelIds.some((id) => filters.labels.includes(id))) return false
    if (!words.length) return true
    const text = foldText(
      [card.title, card.summary, ...card.labelIds.map((id) => names.get(id) ?? '')].join(' '),
      { trim: true },
    )
    return words.every((word) => text.includes(word))
  })
}

export const PR_STATES = ['open', 'review', 'done', 'failed'] as const
export type PrState = (typeof PR_STATES)[number]

/** A pull request link's number (`#23`, from its label or URL) and its last known state. */
export function prChip(link: Pick<BoardCardLink, 'label' | 'url' | 'ref' | 'state'>): {
  number: string | null
  state: PrState | null
} {
  const fromLabel = /^#(\d+)/.exec(link.label)?.[1]
  const fromUrl = /\/pull\/(\d+)/.exec(link.url ?? link.ref)?.[1]
  const number = fromLabel ?? fromUrl
  const state = PR_STATES.find((s) => s === link.state) ?? null
  return { number: number ? `#${number}` : null, state }
}

/** The first `max` assignees and how many more there are ("+N"). */
export function avatarStack<T>(items: readonly T[], max = 3): { shown: T[]; extra: number } {
  if (items.length <= max) return { shown: [...items], extra: 0 }
  return { shown: items.slice(0, max), extra: items.length - max }
}

/**
 * The bot working on a card right now: the one running a linked session (preparing or running) or executing a
 * linked plan; null when nothing linked is under way.
 */
export function liveBotOf(
  card: Pick<BoardCard, 'links'>,
  sessions: Readonly<Record<string, { status: string; botId: string } | undefined>>,
  plans: readonly { id: string; status: string; botId: string }[],
): string | null {
  for (const link of card.links) {
    if (link.kind !== 'session') continue
    const session = sessions[link.ref]
    if (session && (session.status === 'preparing' || session.status === 'running')) return session.botId
  }
  for (const link of card.links) {
    if (link.kind !== 'plan') continue
    const plan = plans.find((p) => p.id === link.ref)
    if (plan?.status === 'executing') return plan.botId
  }
  return null
}

/** The Doing column against the board's limit: `over` from the limit on (it only warns). */
export function doingLoad(count: number, limit: number | null): { text: string; over: boolean } {
  if (!limit) return { text: String(count), over: false }
  return { text: `${count} / ${limit}`, over: count >= limit }
}

export type MarkdownFormat = 'heading' | 'bold' | 'italic' | 'list' | 'code' | 'link'

/**
 * `text` with the selection `[start, end)` formatted as markdown, and the selection to keep afterwards: inline
 * marks wrap it (a placeholder word when empty), line marks prefix each selected line.
 */
export function applyFormat(
  text: string,
  start: number,
  end: number,
  format: MarkdownFormat,
  placeholder = 'text',
): { text: string; start: number; end: number } {
  const from = Math.max(0, Math.min(start, end, text.length))
  const to = Math.min(text.length, Math.max(start, end))
  const picked = text.slice(from, to)
  if (format === 'heading' || format === 'list') {
    const lineStart = text.lastIndexOf('\n', from - 1) + 1
    const block = text.slice(lineStart, to)
    const lines = block.split('\n')
    const prefixed = lines
      .map((line, i) => (format === 'heading' ? `## ${line.replace(/^#+\s*/, '')}` : `${i + 1}. ${line}`))
      .join('\n')
    const next = text.slice(0, lineStart) + prefixed + text.slice(to)
    return { text: next, start: lineStart, end: lineStart + prefixed.length }
  }
  const inner = picked || placeholder
  const [open, close] =
    format === 'bold'
      ? ['**', '**']
      : format === 'italic'
        ? ['_', '_']
        : format === 'code'
          ? inner.includes('\n')
            ? ['```\n', '\n```']
            : ['`', '`']
          : ['[', '](https://)']
  const next = text.slice(0, from) + open + inner + close + text.slice(to)
  return { text: next, start: from + open.length, end: from + open.length + inner.length }
}
