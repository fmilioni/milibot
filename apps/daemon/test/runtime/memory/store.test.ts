import { searchTerms } from '@milibot/agent'
import { beforeEach, describe, expect, it } from 'vitest'

import { MemoryStore } from '../../../src/runtime/memory/store'
import { WorkspaceStore } from '../../../src/runtime/workspace-store'
import { openWorkspaceDb } from '../../../src/workspace-db/open'

let store: WorkspaceStore
let memory: MemoryStore

beforeEach(() => {
  const db = openWorkspaceDb(':memory:')
  let clock = 1_000
  store = new WorkspaceStore(db, () => clock++)
  memory = new MemoryStore(db, () => clock++)
})

function setup() {
  const ana = store.bots.create({ name: 'Ana' })
  const leo = store.bots.create({ name: 'Leo' })
  const dm = store.conversations.create({ type: 'direct', botIds: [ana.id] })
  const other = store.conversations.create({ type: 'direct', botIds: [leo.id] })
  const group = store.conversations.create({ type: 'group', botIds: [ana.id, leo.id] })
  const say = (conversationId: string, content: string, botId?: string) =>
    store.messages.create({
      conversationId,
      authorType: botId ? 'bot' : 'user',
      authorBotId: botId ?? null,
      content,
    })
  return { ana, leo, dm, other, group, say }
}

describe('MemoryStore', () => {
  it('searches messages of the bot conversations with FTS5 (accents, prefixes, exclusions)', () => {
    const { ana, dm, other, group, say } = setup()
    // Portuguese on purpose: accent folding and prefix matching of pt inflections
    say(dm.id, 'O servidor de produção fica em 10.4.2.19.')
    say(dm.id, 'Meu cachorro se chama Biscoito.')
    say(other.id, 'Segredo do Leo: servidor de testes.')
    say(group.id, 'No grupo falamos do servidor novo.')
    say(dm.id, 'Qual é o servidor?') // seq 5: the tail of the DM

    const hits = memory.searchMessages(searchTerms('servidores de producao'), { botId: ana.id, limit: 10 })
    expect(hits.map((m) => m.content)).toEqual(
      expect.arrayContaining([
        'O servidor de produção fica em 10.4.2.19.',
        'No grupo falamos do servidor novo.',
      ]),
    )
    expect(hits.some((m) => m.conversationId === other.id)).toBe(false)
    expect(hits[0]?.content).toContain('produção')

    const ip = memory.searchMessages(searchTerms('ip 10.4.2.19'), { botId: ana.id, limit: 10 })
    expect(ip.map((m) => m.content)).toEqual(['O servidor de produção fica em 10.4.2.19.'])

    const onlyDm = memory.searchMessages(searchTerms('servidor'), {
      botId: ana.id,
      conversationId: dm.id,
      excludeFrom: { conversationId: dm.id, seq: 5 },
      limit: 10,
    })
    expect(onlyDm.map((m) => m.content)).toEqual(['O servidor de produção fica em 10.4.2.19.'])
    expect(memory.searchMessages(['"unbalanced'], { botId: ana.id, limit: 5 })).toEqual([])
  })

  it('stores notes, dedupes them and searches pinned and unpinned ones', () => {
    const { ana, leo } = setup()
    const a = memory.saveNote({ botId: ana.id, content: 'The user is called Fernanda.', pinned: false })
    const again = memory.saveNote({ botId: ana.id, content: 'The user is called Fernanda.', pinned: true })
    expect(again.id).toBe(a.id)
    expect(again.pinned).toBe(true)
    memory.saveNote({ botId: ana.id, content: 'Production AWS account: 1234.', pinned: false })
    memory.saveNote({ botId: leo.id, content: 'Fernanda likes coffee.', pinned: true })
    expect(memory.pinnedNotes(ana.id).map((n) => n.content)).toEqual(['The user is called Fernanda.'])
    expect(memory.searchNotes(ana.id, searchTerms('fernanda'), 10).map((n) => n.content)).toEqual([
      'The user is called Fernanda.',
    ])
    expect(memory.searchNotes(ana.id, searchTerms('production aws'), 10)).toHaveLength(1)

    const updated = memory.updateNote(ana.id, a.id, { content: 'The user is called Fê.', pinned: false })
    expect(updated).toMatchObject({ content: 'The user is called Fê.', pinned: false })
    expect(memory.searchNotes(ana.id, searchTerms('fernanda'), 10)).toEqual([])
    memory.deleteNote(ana.id, a.id)
    expect(memory.listNotes(ana.id).map((n) => n.content)).toEqual(['Production AWS account: 1234.'])
    expect(() => memory.deleteNote(leo.id, a.id)).toThrow(/not found/)
  })

  it('keeps the active summary chain and marks summarized messages as compacted', () => {
    const { ana, dm, say } = setup()
    for (let i = 0; i < 6; i++) say(dm.id, `message ${i}`)
    const s1 = memory.saveSummary({
      botId: ana.id,
      conversationId: dm.id,
      level: 0,
      fromSeq: 1,
      toSeq: 2,
      content: 'first',
      tokenCount: 3,
      llmCallId: null,
      childIds: [],
    })
    const s2 = memory.saveSummary({
      botId: ana.id,
      conversationId: dm.id,
      level: 0,
      fromSeq: 3,
      toSeq: 4,
      content: 'second',
      tokenCount: 3,
      llmCallId: null,
      childIds: [],
    })
    const merged = memory.saveSummary({
      botId: ana.id,
      conversationId: dm.id,
      level: 1,
      fromSeq: 1,
      toSeq: 4,
      content: 'both',
      tokenCount: 3,
      llmCallId: 'llm_x',
      childIds: [s1.id, s2.id],
    })
    expect(memory.activeSummaries(ana.id, dm.id).map((s) => s.id)).toEqual([merged.id])
    expect(memory.listSummaries(dm.id, {}).map((s) => [s.level, s.parentId])).toEqual([
      [0, merged.id],
      [1, null],
      [0, merged.id],
    ])
    const compacted = store.db.prepare('SELECT seq, compacted FROM messages ORDER BY seq').all() as {
      seq: number
      compacted: number
    }[]
    expect(compacted.map((r) => r.compacted)).toEqual([1, 1, 1, 1, 0, 0])
    expect(memory.messagesAfter(dm.id, 4, { limit: 10 }).map((m) => m.content)).toEqual([
      'message 4',
      'message 5',
    ])
    expect(memory.messagesAfter(dm.id, 0, { limit: 2, newest: true }).map((m) => m.seq)).toEqual([5, 6])
    // Still searchable after compaction.
    expect(memory.searchMessages(['message'], { botId: ana.id, limit: 10 })).toHaveLength(6)
  })
})

describe('display allocation', () => {
  it('reserves a deleted bot display until the VM confirms the removal, then reuses it', () => {
    const chief = store.bots.create({ name: 'Chief' })
    const ana = store.bots.create({ name: 'Ana' })
    const leo = store.bots.create({ name: 'Leo' })
    expect([chief.displayNum, ana.displayNum, leo.displayNum]).toEqual([1, 2, 3])
    store.deleteBot(ana.id)
    expect(store.bots.pendingRemovals()).toEqual([{ id: ana.id, slug: 'ana', displayNum: 2 }])
    expect(store.bots.create({ name: 'Bia' }).displayNum).toBe(4)
    store.bots.markRemovedFromVm('ana')
    expect(store.bots.pendingRemovals()).toEqual([])
    const reused = store.bots.create({ name: 'Ana' })
    expect(reused.displayNum).toBe(2)
    expect(reused.slug).toBe('ana-2')
    expect(reused.linuxUid).toBe(2005)
  })

  it('refuses more bots than the guest has displays', () => {
    for (let i = 0; i < 50; i++) store.bots.create({ name: `Bot ${i}` })
    expect(() => store.bots.create({ name: 'Extra' })).toThrow(/at most 50 bots/)
  })
})

describe('workspace memory', () => {
  it('keeps bot and workspace notes apart', () => {
    const { ana, leo } = setup()
    memory.saveNote({ botId: ana.id, content: 'Ana only.', pinned: true })
    const shared = memory.saveNote({ botId: ana.id, content: 'Everyone.', pinned: false, scope: 'workspace' })
    expect(shared).toMatchObject({ scope: 'workspace', botId: null, pinned: true })
    expect(memory.pinnedNotes(ana.id).map((n) => n.content)).toEqual(['Ana only.'])
    expect(memory.pinnedNotes(leo.id)).toEqual([])
    expect(memory.workspaceNotes().map((n) => n.content)).toEqual(['Everyone.'])
    expect(memory.searchNotes(leo.id, searchTerms('everyone'), 5).map((n) => n.content)).toEqual([
      'Everyone.',
    ])
    expect(() => memory.updateNote(ana.id, shared.id, { content: 'x' })).toThrow()
    const moved = memory.reviseNote(shared.id, { content: 'Leo only now.', scope: 'bot', botId: leo.id })
    expect(moved).toMatchObject({ scope: 'bot', botId: leo.id })
  })
})
