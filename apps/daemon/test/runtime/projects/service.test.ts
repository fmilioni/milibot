import { type NewAgentMessage, searchTerms } from '@milibot/agent'
import { FakeEmbeddingProvider } from '@milibot/agent/embeddings'
import type { Bot, Message, VmInfo, WorkspaceEvent } from '@milibot/shared'
import { beforeEach, describe, expect, it } from 'vitest'

import { type Db } from '../../../src/db/sqlite'
import { EmbeddingService } from '../../../src/runtime/embeddings/service'
import { chunkContent } from '../../../src/runtime/knowledge/chunker'
import { knowledgeCorpus } from '../../../src/runtime/knowledge/corpus'
import { KnowledgeService } from '../../../src/runtime/knowledge/service'
import { KnowledgeStore } from '../../../src/runtime/knowledge/store'
import { KnowledgeTools } from '../../../src/runtime/knowledge/tools'
import { MemoryStore } from '../../../src/runtime/memory/store'
import { ProjectService } from '../../../src/runtime/projects/service'
import { ProjectTools } from '../../../src/runtime/projects/tools'
import { ProviderStore } from '../../../src/runtime/providers/store'
import { WorkspaceStore } from '../../../src/runtime/workspace-store'
import { MemorySecretStore } from '../../../src/secrets/secret-store'
import { openWorkspaceDb } from '../../../src/workspace-db/open'
import { testProviders } from '../../support/providers'

let db: Db
let clock: number

beforeEach(() => {
  db = openWorkspaceDb(':memory:')
  clock = 1_000
})

const now = () => clock++

function setup() {
  const store = new WorkspaceStore(db, now)
  const memory = new MemoryStore(db, now)
  const chief = store.bots.create({ name: 'Chief' })
  const dm = store.conversations.create({ type: 'direct', botIds: [chief.id] })
  const events: WorkspaceEvent[] = []
  const lines: NewAgentMessage[] = []
  const docs = new KnowledgeStore(db, now)
  const knowledge = new KnowledgeService({
    docs,
    store,
    projects: {
      exists: (id): boolean => projects.find(id) !== null,
      ofConversation: (id): string | null => projects.current(id)?.id ?? null,
    },
    workspaceDir: '/nonexistent/milibot-test',
    vm: {
      status: () => ({ state: 'stopped', desktops: 0 }) as unknown as VmInfo,
      runningGuest: () => {
        throw new Error('VM not running')
      },
      subscribe: () => () => undefined,
    } as unknown as ConstructorParameters<typeof KnowledgeService>[0]['vm'],
    host: { writeText: async () => ({ text: 'Summary.', llmCallId: null }) },
    providers: new ProviderStore({ db, workspaceId: 'ws', secrets: new MemorySecretStore() }),
    catalog: testProviders(db).catalog,
    attachments: {
      get: () => {
        throw new Error('no attachments')
      },
      stagedFile: () => null,
      maxFileMb: () => 50,
    },
    emit: () => undefined,
    embeddings: new EmbeddingService({
      chunks: knowledgeCorpus(docs),
      getSetting: (key, fallback) => store.settings.get(key, fallback),
      setSetting: (key, value) => store.settings.set(key, value),
      createProvider: async () => new FakeEmbeddingProvider({ key: 'fake:test' }),
      now,
      log: () => undefined,
    }),
    modelsDir: null,
    now,
    thresholds: { suggestMinScore: 0.2, chunkMinScore: 0.2 },
  })
  const projects = new ProjectService({
    db,
    store,
    emit: (event) => events.push(event),
    appendMessage: (message) => {
      lines.push(message)
      return { id: `msg_${lines.length}` } as Message
    },
    now,
    knowledgeCatalog: (bot, projectId) => knowledge.projectCatalog(bot, projectId),
    projectNotes: (projectId) => memory.projectNotes(projectId).map((n) => n.content),
  })
  const tools = new KnowledgeTools({ service: knowledge, botName: () => null, projects })
  const ctx = (bot: Bot, conversationId: string | null = dm.id) => ({
    bot,
    conversationId,
    turnId: 'trn_1',
    signal: new AbortController().signal,
  })
  const call = async (
    service: { execute: ProjectTools['execute'] | KnowledgeTools['execute'] },
    bot: Bot,
    name: string,
    args: Record<string, unknown>,
    conversationId: string | null = dm.id,
  ) => {
    const result = await service.execute(ctx(bot, conversationId), { id: 't', name, arguments: args })
    return { text: result.content.map((p) => (p.type === 'text' ? p.text : '')).join(''), result }
  }
  const projectTools = new ProjectTools({ projects })
  return { store, memory, knowledge, projects, projectTools, tools, chief, dm, events, lines, call }
}

function addDoc(knowledge: KnowledgeService, title: string, content: string, projectId: string | null) {
  const row = knowledge.docs.insertDoc({
    title,
    fileName: `${title}.md`,
    mime: 'text/markdown',
    kind: 'markdown',
    source: 'upload',
    authorType: 'user',
    bytes: content.length,
    status: 'ready',
    projectId,
  })
  knowledge.docs.replaceChunks(row.id, chunkContent(content, { targetTokens: 40, maxTokens: 80 }))
  return row
}

describe('ProjectService', () => {
  it('creates projects with unique slugs, resolves them by name/slug/id and refuses duplicate names', () => {
    const { projects } = setup()
    const shop = projects.create({ name: 'New Store!', description: 'E-commerce', repos: ['store-api'] })
    expect(shop).toMatchObject({ slug: 'new-store', repos: ['store-api'], archivedAt: null })
    const other = projects.create({ name: 'New store 2', description: '', repos: [] })
    expect(other.slug).toBe('new-store-2')
    expect(() => projects.create({ name: 'néw störe!', description: '', repos: [] })).toThrow(
      /already exists/,
    )
    expect(projects.resolve('NEW STORE!')).toEqual({ project: shop })
    expect(projects.resolve(shop.id)).toEqual({ project: shop })
    // Portuguese on purpose: 'geral' is an accepted alias of 'general'
    expect(projects.resolve('geral')).toEqual({ general: true })
    expect(projects.resolve('store')).toMatchObject({ problem: expect.stringContaining('2 projects') })
    expect(projects.resolve('trip')).toMatchObject({ problem: expect.stringContaining('no project') })
  })

  it('sets the current project of a conversation with a system line and clears it on delete', () => {
    const { projects, store, dm, chief, lines, events } = setup()
    const shop = projects.create({ name: 'Store', description: '', repos: [] })
    projects.setCurrent(dm.id, shop.id, { type: 'bot', bot: chief, turnId: 'trn_1' })
    expect(store.conversations.get(dm.id).projectId).toBe(shop.id)
    expect(lines.at(-1)?.payload).toMatchObject({
      type: 'system',
      event: 'project_changed',
      params: { projectName: 'Store', actor: 'bot', actorName: 'Chief' },
    })
    projects.delete(shop.id)
    expect(store.conversations.get(dm.id).projectId).toBeNull()
    expect(events.map((e) => e.type)).toEqual(
      expect.arrayContaining(['project.updated', 'conversation.updated', 'project.deleted']),
    )
  })

  it('runs the project tools', async () => {
    const { projectTools, chief, call, store, dm } = setup()
    const created = await call(projectTools, chief, 'project_create', {
      name: 'Café Trip',
      description: 'October itinerary',
    })
    expect(created.text).toContain('Created the project Café Trip')
    const set = await call(projectTools, chief, 'project_set_current', { project: 'cafe trip' })
    expect(set.result.isError).toBeUndefined()
    expect(store.conversations.get(dm.id).projectId).not.toBeNull()
    const list = await call(projectTools, chief, 'project_list', {})
    expect(list.text).toContain('Current project of this conversation: Café Trip')
    expect(list.text).toContain('- Café Trip [current]')
    await call(projectTools, chief, 'project_update', { project: 'Café Trip', archived: true })
    const refused = await call(projectTools, chief, 'project_set_current', { project: 'Café Trip' })
    expect(refused.result.isError).toBe(true)
    await call(projectTools, chief, 'project_set_current', { project: 'general' })
    expect(store.conversations.get(dm.id).projectId).toBeNull()
  })

  it("builds the project's block with its notes and documents only", () => {
    const { projects, memory, knowledge, chief } = setup()
    const shop = projects.create({ name: 'Store', description: "Acme's e-commerce", repos: ['store-api'] })
    const trip = projects.create({ name: 'Trip', description: '', repos: [] })
    memory.saveNote({
      botId: '',
      content: 'Store deploy on VPS 2',
      pinned: true,
      scope: 'workspace',
      projectId: shop.id,
    })
    memory.saveNote({
      botId: '',
      content: 'Hotel in Kyoto',
      pinned: true,
      scope: 'workspace',
      projectId: trip.id,
    })
    memory.saveNote({ botId: '', content: 'The user lives in Brazil', pinned: true, scope: 'workspace' })
    const spec = addDoc(knowledge, 'Store specification', 'Cart and checkout.', shop.id)
    knowledge.docs.update(spec.id, { pinned: true })
    addDoc(knowledge, 'Itinerary', 'Tokyo and Kyoto.', trip.id)
    addDoc(knowledge, 'Code rules', 'Always tests.', null)

    const block = projects.block(chief, shop.id)
    expect(block).toMatch(/^# Current project: Store\nAcme's e-commerce\nRepositories: store-api/)
    expect(block).toContain('- Store deploy on VPS 2')
    expect(block).not.toContain('Kyoto')
    expect(block).not.toContain('Brazil')
    expect(block).toContain('## Project documents\n1 document of this project')
    expect(block).toContain('- Store specification (markdown)')
    const withoutKnowledge = projects.block(chief, shop.id, { knowledge: false })
    expect(withoutKnowledge).toContain('- Store deploy on VPS 2')
    expect(withoutKnowledge).not.toContain('## Project documents')
    expect(knowledge.catalog(chief)).toMatch(/^# Knowledge base\n1 general document/)
    expect(memory.workspaceNotes().map((n) => n.content)).toEqual(['The user lives in Brazil'])
  })
})

describe('project views', () => {
  it('searches general + current project by default, one project or every project on request', async () => {
    const { projects, tools, knowledge, chief, call, dm } = setup()
    const shop = projects.create({ name: 'Store', description: '', repos: [] })
    const trip = projects.create({ name: 'Trip', description: '', repos: [] })
    addDoc(knowledge, 'Store deploy', 'The server deploy uses docker compose.', shop.id)
    addDoc(knowledge, 'Trip deploy', 'The server deploy of the trip site uses rsync.', trip.id)
    addDoc(knowledge, 'General deploy', 'Every server deploy goes through the firewall.', null)
    const titles = (text: string) =>
      ['Store deploy', 'Trip deploy', 'General deploy'].filter((t) => text.includes(t))

    const none = await call(tools, chief, 'knowledge_search', { query: 'server deploy' })
    expect(titles(none.text)).toEqual(['General deploy'])
    expect(none.text).not.toContain('Store deploy')

    projects.setCurrent(dm.id, shop.id, { type: 'user' })
    const current = await call(tools, chief, 'knowledge_search', { query: 'server deploy' })
    expect(titles(current.text).sort()).toEqual(['General deploy', 'Store deploy'])

    const other = await call(tools, chief, 'knowledge_search', {
      query: 'server deploy',
      project: 'Trip',
    })
    expect(titles(other.text)).toEqual(['Trip deploy'])
    const all = await call(tools, chief, 'knowledge_search', { query: 'server deploy', project: 'all' })
    expect(titles(all.text).sort()).toEqual(['General deploy', 'Store deploy', 'Trip deploy'])
    const general = await call(tools, chief, 'knowledge_list', { project: 'general' })
    expect(titles(general.text)).toEqual(['General deploy'])
    const unknown = await call(tools, chief, 'knowledge_search', { query: 'deploy', project: 'Wedding' })
    expect(unknown.result.isError).toBe(true)
  })

  it('writes new documents into the current project unless told otherwise', async () => {
    const { projects, tools, knowledge, chief, call, dm } = setup()
    const shop = projects.create({ name: 'Store', description: '', repos: [] })
    projects.setCurrent(dm.id, shop.id, { type: 'user' })
    await call(tools, chief, 'knowledge_write', { title: 'Store architecture', content: '# API\nNode.' })
    await call(tools, chief, 'knowledge_write', {
      title: 'Code rules',
      content: '# Rules\nAlways tests.',
      project: 'general',
    })
    const rows = knowledge.docs.all()
    expect(rows.find((r) => r.title === 'Store architecture')?.project_id).toBe(shop.id)
    expect(rows.find((r) => r.title === 'Code rules')?.project_id).toBeNull()
    const list = await knowledge.list({ projectId: 'general', page: 1, pageSize: 50 })
    expect(list.docs.map((d) => d.title)).toEqual(['Code rules'])
    const onlyShop = await knowledge.list({ projectId: shop.id, page: 1, pageSize: 50 })
    expect(onlyShop.docs.map((d) => d.title)).toEqual(['Store architecture'])
  })

  it('searches workspace notes of the general scope and the chosen projects', () => {
    const { projects, memory, chief } = setup()
    const shop = projects.create({ name: 'Store', description: '', repos: [] })
    const trip = projects.create({ name: 'Trip', description: '', repos: [] })
    memory.saveNote({
      botId: '',
      content: 'Store server on VPS 2',
      pinned: true,
      scope: 'workspace',
      projectId: shop.id,
    })
    memory.saveNote({
      botId: '',
      content: 'Trip blog server',
      pinned: true,
      scope: 'workspace',
      projectId: trip.id,
    })
    memory.saveNote({ botId: '', content: 'General backup server', pinned: true, scope: 'workspace' })
    memory.saveNote({ botId: chief.id, content: 'My favorite server', pinned: true })
    const found = (view?: Parameters<MemoryStore['searchNotes']>[3]) =>
      memory
        .searchNotes(chief.id, searchTerms('server'), 10, view)
        .map((n) => n.content)
        .sort()
    expect(found({ mode: 'default', current: shop.id })).toEqual([
      'General backup server',
      'My favorite server',
      'Store server on VPS 2',
    ])
    expect(found({ mode: 'default', current: null })).toEqual(['General backup server', 'My favorite server'])
    expect(found({ mode: 'only', projectId: trip.id })).toEqual(['My favorite server', 'Trip blog server'])
    expect(found()).toHaveLength(4)
    expect(memory.listWorkspaceNotes()).toHaveLength(3)
    expect(() =>
      memory.saveNote({
        botId: '',
        content: 'x',
        pinned: true,
        scope: 'workspace',
        projectId: 'prj_missing',
      }),
    ).toThrow(/Unknown project/)
  })
})
