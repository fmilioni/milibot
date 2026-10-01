import { FIRST_BOT_DEFAULTS } from '@milibot/shared'
import { beforeEach, describe, expect, it } from 'vitest'

import { botSlug } from '../../src/runtime/bots/store'
import { WorkspaceStore } from '../../src/runtime/workspace-store'
import { openWorkspaceDb } from '../../src/workspace-db/open'
import { seedWorkspace } from '../../src/workspace-db/seed'

let store: WorkspaceStore

beforeEach(() => {
  const db = openWorkspaceDb(':memory:')
  let clock = 1_000
  store = new WorkspaceStore(db, () => clock++)
})

describe('seedWorkspace', () => {
  it('creates the first bot with a pinned direct conversation, once', () => {
    const first = seedWorkspace(store, 'pt-BR')
    expect(first.seeded).toBe(true)
    const second = seedWorkspace(store, 'pt-BR')
    expect(second).toEqual({ ...first, seeded: false })

    const bots = store.bots.list()
    expect(bots).toHaveLength(1)
    // Portuguese on purpose: the pt-BR first-bot defaults
    expect(bots[0]).toMatchObject({
      name: 'Maestro',
      label: 'Equipe',
      avatar: { shape: 'square', color: 'blue', eyes: 'capsule' },
      linuxUid: 2001,
      displayNum: 1,
      status: 'idle',
    })
    const conversations = store.conversations.list()
    expect(conversations).toHaveLength(1)
    expect(conversations[0]).toMatchObject({
      type: 'direct',
      memberBotIds: [first.botId],
      sidebar: { pinned: true, hidden: false, unreadCount: 0 },
    })
    expect(store.settings.get('agents.max_parallel', 0)).toBe(3)
    expect(
      store.db.prepare('SELECT skill_id, enabled FROM bot_skill_prefs WHERE bot_id = ?').all(first.botId),
    ).toEqual([{ skill_id: 'builtin:team-management', enabled: 1 }])
  })

  it.each(['pt-BR', 'en'] as const)('writes the default persona in the app language (%s)', (language) => {
    seedWorkspace(store, language)
    const defaults = FIRST_BOT_DEFAULTS[language]
    expect(store.bots.first()).toMatchObject({
      name: defaults.name,
      label: defaults.label,
      systemPrompt: defaults.persona,
    })
  })
})

describe('bots', () => {
  it('allocates unique slugs, uids and displays', () => {
    const a = store.bots.create({ name: 'Café Analyst' })
    const b = store.bots.create({ name: 'Café Analyst' })
    expect(a.slug).toBe('cafe-analyst')
    expect(b.slug).toBe('cafe-analyst-2')
    expect(b.linuxUid).toBe(a.linuxUid + 1)
    expect(b.displayNum).toBe(a.displayNum + 1)
  })

  it('soft-deletes bots and their direct conversations, but never the last one', () => {
    const { botId } = seedWorkspace(store, 'pt-BR')
    const bot = store.bots.create({ name: 'Dex' })
    const dm = store.conversations.create({ type: 'direct', botIds: [bot.id] })
    expect(store.deleteBot(botId).deletedConversationIds).toHaveLength(1)
    expect(store.bots.first()?.id).toBe(bot.id)
    expect(() => store.deleteBot(bot.id)).toThrow(/last bot/)
    expect(store.bots.list().map((b) => b.id)).toEqual([bot.id])
    const other = store.bots.create({ name: 'Iris' })
    expect(store.deleteBot(bot.id).deletedConversationIds).toEqual([dm.id])
    expect(store.bots.list().map((b) => b.id)).toEqual([other.id])
    expect(() => store.conversations.get(dm.id)).toThrow(/not found/)
    const again = store.bots.create({ name: 'Dex' })
    expect(again.slug).toBe('dex-2')
  })

  it('updates only provided fields', () => {
    const bot = store.bots.create({ name: 'Iris', label: 'Analyst' })
    const updated = store.bots.update(bot.id, { label: 'Research', model: 'x/y' })
    expect(updated).toMatchObject({ name: 'Iris', label: 'Research', model: 'x/y' })
  })
})

describe('conversations and messages', () => {
  it('reuses the existing direct conversation for a bot', () => {
    const bot = store.bots.create({ name: 'Lua' })
    const first = store.conversations.create({ type: 'direct', botIds: [bot.id] })
    const second = store.conversations.create({ type: 'direct', botIds: [bot.id] })
    expect(second.id).toBe(first.id)
  })

  it('paginates messages oldest-first with a cursor', () => {
    const bot = store.bots.create({ name: 'Watcher' })
    const conversation = store.conversations.create({ type: 'direct', botIds: [bot.id] })
    const ids = Array.from(
      { length: 5 },
      (_, i) =>
        store.messages.create({ conversationId: conversation.id, authorType: 'user', content: `m${i}` }).id,
    )
    const page1 = store.messages.list(conversation.id, { limit: 2 })
    expect(page1.messages.map((m) => m.content)).toEqual(['m3', 'm4'])
    expect(page1.hasMore).toBe(true)
    const page2 = store.messages.list(conversation.id, { limit: 10, before: ids[3] })
    expect(page2.messages.map((m) => m.content)).toEqual(['m0', 'm1', 'm2'])
    expect(page2.hasMore).toBe(false)
  })

  it('tracks unread bot messages and clears them on read', () => {
    const bot = store.bots.create({ name: 'Dex' })
    const conversation = store.conversations.create({ type: 'direct', botIds: [bot.id] })
    store.messages.create({ conversationId: conversation.id, authorType: 'user', content: 'hi' })
    store.messages.create({
      conversationId: conversation.id,
      authorType: 'bot',
      authorBotId: bot.id,
      content: 'hello',
    })
    store.messages.create({
      conversationId: conversation.id,
      authorType: 'bot',
      authorBotId: bot.id,
      content: 'done',
    })
    const summary = store.conversations.get(conversation.id)
    expect(summary.sidebar.unreadCount).toBe(2)
    expect(summary.lastMessage?.content).toBe('done')
    store.conversations.markRead(conversation.id)
    expect(store.conversations.get(conversation.id).sidebar.unreadCount).toBe(0)
  })

  it('rejects bot authors that are not members', () => {
    const a = store.bots.create({ name: 'A' })
    const b = store.bots.create({ name: 'B' })
    const conversation = store.conversations.create({ type: 'direct', botIds: [a.id] })
    expect(() =>
      store.messages.create({
        conversationId: conversation.id,
        authorType: 'bot',
        authorBotId: b.id,
        content: 'x',
      }),
    ).toThrow(/member/)
  })

  it('searches message history with FTS ignoring accents', () => {
    const bot = store.bots.create({ name: 'Analyst' })
    const conversation = store.conversations.create({ type: 'direct', botIds: [bot.id] })
    store.messages.create({
      conversationId: conversation.id,
      authorType: 'user',
      content: 'Relatório de inflação',
    })
    store.messages.create({ conversationId: conversation.id, authorType: 'user', content: 'Another topic' })
    expect(store.messages.search('inflacao').map((m) => m.content)).toEqual(['Relatório de inflação'])
  })

  it('finds active bots by id', () => {
    const bot = store.bots.create({ name: 'Nina' })
    const other = store.bots.create({ name: 'Rui' })
    expect(store.bots.find(bot.id)?.name).toBe('Nina')
    expect(store.bots.find('bot_missing')).toBeNull()
    store.deleteBot(other.id)
    expect(store.bots.find(other.id)).toBeNull()
    expect(() => store.bots.get(other.id)).toThrow(/not found/)
  })

  it('resolves the bot a model names by id, slug, name or name prefix', () => {
    const ana = store.bots.create({ name: 'Ána Paula' })
    store.bots.create({ name: 'Rui' })
    expect(store.bots.resolveRef(ana.id)?.id).toBe(ana.id)
    expect(store.bots.resolveRef('@ana-paula')?.id).toBe(ana.id)
    expect(store.bots.resolveRef('ANA PAULA')?.id).toBe(ana.id)
    expect(store.bots.resolveRef('ana')?.id).toBe(ana.id)
    expect(store.bots.resolveRef('an')).toBeNull()
  })

  it('saves the fields that are set under their setting keys', () => {
    store.settings.setMany({ a: 'x.a', b: 'x.b' }, { a: 1, b: undefined })
    expect(store.settings.get('x.a', 0)).toBe(1)
    expect(store.settings.get('x.b', 'unset')).toBe('unset')
  })

  it('posts cards in the conversation a bot works in, never in a bot-to-bot one', () => {
    const nina = store.bots.create({ name: 'Nina' })
    const rui = store.bots.create({ name: 'Rui' })
    const dm = store.conversations.create({ type: 'direct', botIds: [nina.id] })
    const group = store.conversations.create({ type: 'group', botIds: [nina.id, rui.id], title: 'Squad' })
    const other = store.conversations.create({ type: 'group', botIds: [rui.id], title: 'Other' })
    const internal = store.conversations.create({ type: 'internal', botIds: [nina.id, rui.id] })
    expect(store.conversations.forCard(nina, group.id)).toBe(group.id)
    expect(store.conversations.forCard(nina, internal.id)).toBe(dm.id)
    expect(store.conversations.forCard(nina, other.id)).toBe(dm.id)
    expect(store.conversations.forCard(nina, null)).toBe(dm.id)
    expect(() => store.conversations.forCard(rui, null)).toThrow(/No conversation/)
  })

  it('renames and soft-deletes conversations', () => {
    const bot = store.bots.create({ name: 'Nina' })
    const group = store.conversations.create({ type: 'group', botIds: [bot.id], title: 'Old' })
    store.conversations.rename(group.id, 'New')
    expect(store.conversations.get(group.id).title).toBe('New')
    store.conversations.softDelete(group.id)
    expect(() => store.conversations.get(group.id)).toThrow(/not found/)
    const row = store.db.prepare('SELECT deleted_at FROM conversations WHERE id = ?').get(group.id) as {
      deleted_at: number | null
    }
    expect(row.deleted_at).not.toBeNull()
  })

  it('keeps internal conversations out of the sidebar', () => {
    const a = store.bots.create({ name: 'A' })
    const b = store.bots.create({ name: 'B' })
    const internal = store.conversations.create({ type: 'internal', botIds: [a.id, b.id] })
    const count = store.db
      .prepare('SELECT COUNT(*) AS n FROM sidebar_items WHERE conversation_id = ?')
      .get(internal.id) as { n: number }
    expect(count.n).toBe(0)
  })
})

describe('botSlug', () => {
  it('normalizes names', () => {
    expect(botSlug('Chief of Staff!')).toBe('chief-of-staff')
    expect(botSlug('***')).toBe('bot')
  })
})
