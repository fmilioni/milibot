import type { BoardCardLinkKind } from '@milibot/shared'

import { resolveByRef } from '../tools-core'

type LinkedItemKind = Extract<BoardCardLinkKind, 'plan' | 'session' | 'design'>

/** The plans, work sessions and designs a card can link to, each list newest first. */
export type LinkTargets = Record<LinkedItemKind, () => Array<{ id: string; title: string }>>

/** What plans and work sessions need from boards: the card they work on. */
export interface BoardCardLinks {
  /** The id of a card a bot names (id or title); throws when there is none. */
  resolveCardId(ref: string): string
  linkPlan(cardId: string, plan: { id: string; title: string }): void
  /** Links the session and moves a card still to do to doing, assigned to the bot. */
  linkSession(cardId: string, session: { id: string; title: string }, botId: string): void
  cardOfPlan(planId: string): string | null
  cardOfSession(sessionId: string): string | null
  /** The card for a session brief: board, card, body and comments. */
  briefFor(cardId: string): string | null
}

export type LinkTarget = { ref: string; label: string; url: string | null } | { problem: string }

const ITEM_NAME: Record<LinkedItemKind, string> = { plan: 'plan', session: 'work session', design: 'design' }

/** What a link points to: a plan, session or design found by id or title, or a URL or commit sha. */
export function linkTarget(targets: LinkTargets, kind: BoardCardLinkKind, ref: string): LinkTarget {
  const value = ref.trim()
  switch (kind) {
    case 'plan':
    case 'session':
    case 'design': {
      const match = resolveByRef(targets[kind](), value, {
        id: (item) => item.id,
        names: (item) => [item.title],
        ambiguous: { exact: 'first', partial: 'report' },
      })
      return 'found' in match
        ? { ref: match.found.id, label: match.found.title, url: null }
        : { problem: `There is no ${ITEM_NAME[kind]} "${value}".` }
    }
    case 'commit':
      return /^[0-9a-f]{7,40}$/i.test(value)
        ? { ref: value.toLowerCase(), label: value.slice(0, 7).toLowerCase(), url: null }
        : /^https:\/\/\S+\/commit\/([0-9a-f]{7,40})/i.test(value)
          ? {
              ref: (/\/commit\/([0-9a-f]{7,40})/i.exec(value)?.[1] as string).toLowerCase(),
              label: (/\/commit\/([0-9a-f]{7})/i.exec(value)?.[1] as string).toLowerCase(),
              url: value,
            }
          : { problem: 'A commit is its sha (7 to 40 hex characters) or its https URL.' }
    case 'pr':
    case 'url': {
      if (!/^https?:\/\/\S+$/i.test(value)) return { problem: `"${value}" is not a URL.` }
      const number = kind === 'pr' ? /\/pull\/(\d+)/.exec(value)?.[1] : undefined
      const label = number ? `#${number}` : value.replace(/^https?:\/\//i, '').slice(0, 120)
      return { ref: value, label, url: value }
    }
  }
}
