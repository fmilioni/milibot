import { type ConversationType, type RefInfo, type RefKind, refKindOf } from '@milibot/shared'

import type { EndpointHandlers } from '../../handlers'

interface Named {
  id: string
  name: string
}

/** Each domain's batch lookup of the items among `ids` that exist (one `IN (…)` query each). */
interface RefLookups {
  card(ids: readonly string[]): Array<Named & { boardId: string }>
  board(ids: readonly string[]): Named[]
  design(ids: readonly string[]): Named[]
  frame(ids: readonly string[]): Array<Named & { designId: string }>
  plan(ids: readonly string[]): Named[]
  session(ids: readonly string[]): Named[]
  doc(ids: readonly string[]): Named[]
  project(ids: readonly string[]): Named[]
  skill(ids: readonly string[]): Named[]
  routine(ids: readonly string[]): Array<Named & { botId: string }>
  bot(ids: readonly string[]): Named[]
  conversation(
    ids: readonly string[],
  ): Array<{ id: string; type: ConversationType; title: string | null; memberBotIds: string[] }>
  sessionsOfConversations(conversationIds: readonly string[]): Array<{ id: string; conversationId: string }>
}

export interface RefDeps {
  lookups: RefLookups
}

/** Current names of the ids written in text (chat, cards, plans…), so the app can show them as links. */
export class RefService {
  constructor(private readonly deps: RefDeps) {}

  resolve(ids: readonly string[]): RefInfo[] {
    const byKind = new Map<RefKind, string[]>()
    for (const id of new Set(ids)) {
      const kind = refKindOf(id)
      if (kind) byKind.set(kind, [...(byKind.get(kind) ?? []), id])
    }
    const { lookups } = this.deps
    const of = (kind: RefKind) => byKind.get(kind) ?? []
    const named = (kind: RefKind, rows: Named[]): RefInfo[] =>
      rows.map((row) => ({ id: row.id, kind, name: row.name }))
    return [
      ...lookups
        .card(of('card'))
        .map((r) => ({ id: r.id, kind: 'card' as const, name: r.name, boardId: r.boardId })),
      ...named('board', lookups.board(of('board'))),
      ...named('design', lookups.design(of('design'))),
      ...lookups
        .frame(of('frame'))
        .map((r) => ({ id: r.id, kind: 'frame' as const, name: r.name, designId: r.designId })),
      ...named('plan', lookups.plan(of('plan'))),
      ...named('session', lookups.session(of('session'))),
      ...named('doc', lookups.doc(of('doc'))),
      ...named('project', lookups.project(of('project'))),
      ...named('skill', lookups.skill(of('skill'))),
      ...lookups
        .routine(of('routine'))
        .map((r) => ({ id: r.id, kind: 'routine' as const, name: r.name, botId: r.botId })),
      ...named('bot', lookups.bot(of('bot'))),
      ...this.conversations(of('conversation')),
    ]
  }

  /** A conversation is named by its title, else its bots; a session's points at the session. */
  private conversations(ids: string[]): RefInfo[] {
    const { lookups } = this.deps
    const rows = lookups.conversation(ids)
    if (!rows.length) return []
    const botNames = new Map(
      lookups.bot([...new Set(rows.flatMap((r) => r.memberBotIds))]).map((b) => [b.id, b.name]),
    )
    const sessions = new Map(
      lookups
        .sessionsOfConversations(rows.filter((r) => r.type === 'session').map((r) => r.id))
        .map((s) => [s.conversationId, s.id]),
    )
    return rows.map((row) => {
      const members = row.memberBotIds.flatMap((id) => botNames.get(id) ?? [])
      const sessionId = sessions.get(row.id)
      const botId = row.type === 'direct' ? row.memberBotIds[0] : undefined
      return {
        id: row.id,
        kind: 'conversation' as const,
        name: row.title || members.join(', '),
        conversationType: row.type,
        ...(botId ? { botId } : {}),
        ...(sessionId ? { sessionId } : {}),
      }
    })
  }

  handlers(): EndpointHandlers<'resolveRefs'> {
    return { resolveRefs: ({ body }) => ({ refs: this.resolve(body.ids) }) }
  }
}
