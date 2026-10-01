import {
  type EmbeddingProvider,
  type EmbeddingSetting,
  FakeEmbeddingProvider,
} from '@milibot/agent/embeddings'
import type { VmInfo } from '@milibot/shared'
import { beforeEach } from 'vitest'

import type { Db } from '../../../src/db/sqlite'
import { EmbeddingService } from '../../../src/runtime/embeddings/service'
import { chunkContent } from '../../../src/runtime/knowledge/chunker'
import { knowledgeCorpus } from '../../../src/runtime/knowledge/corpus'
import { KnowledgeService } from '../../../src/runtime/knowledge/service'
import { KnowledgeStore } from '../../../src/runtime/knowledge/store'
import { ProviderStore } from '../../../src/runtime/providers/store'
import { WorkspaceStore } from '../../../src/runtime/workspace-store'
import { MemorySecretStore } from '../../../src/secrets/secret-store'
import { openWorkspaceDb } from '../../../src/workspace-db/open'
import { testProviders } from '../../support/providers'

export interface KnowledgeTest {
  db: Db
  /** The embedding service's settings (outside the database). */
  settings: Map<string, unknown>
  now: () => number
}

/** A fresh in-memory workspace database and settings for each test of the file. */
export function knowledgeTest(): KnowledgeTest {
  const t = {} as KnowledgeTest
  beforeEach(() => {
    let clock = 1_000
    t.db = openWorkspaceDb(':memory:')
    t.settings = new Map()
    t.now = () => clock++
  })
  return t
}

export function paragraphs(topic: string, count: number, words = 60): string {
  return Array.from({ length: count }, (_, i) =>
    Array.from({ length: words }, (_, w) => `${topic}${(i * words + w) % 17}`).join(' '),
  ).join('\n\n')
}

export function makeStore(t: KnowledgeTest): KnowledgeStore {
  return new KnowledgeStore(t.db, t.now)
}

export function addDoc(
  store: KnowledgeStore,
  title: string,
  content: string,
  extra: Partial<Parameters<KnowledgeStore['insertDoc']>[0]> & { summary?: string } = {},
) {
  const { summary, ...rest } = extra
  const row = store.insertDoc({
    title,
    fileName: `${title}.md`,
    mime: 'text/markdown',
    kind: 'markdown',
    source: 'upload',
    authorType: 'user',
    bytes: content.length,
    status: 'ready',
    ...rest,
  })
  store.replaceChunks(row.id, chunkContent(content, { targetTokens: 40, maxTokens: 80 }))
  if (summary) store.update(row.id, { summary })
  return { id: row.id, content }
}

export function embeddingService(
  t: KnowledgeTest,
  store: KnowledgeStore,
  factory?: (s: EmbeddingSetting) => EmbeddingProvider,
) {
  return new EmbeddingService({
    chunks: knowledgeCorpus(store),
    getSetting: <T>(key: string, fallback: T) =>
      t.settings.has(key) ? (t.settings.get(key) as T) : fallback,
    setSetting: (key, value) => t.settings.set(key, value),
    createProvider: async (setting) =>
      factory?.(setting) ??
      new FakeEmbeddingProvider({
        key: `fake:${setting.provider === 'local' ? setting.level : setting.model}`,
      }),
    now: t.now,
    log: () => undefined,
  })
}

function vmStub(state: VmInfo['state'] = 'stopped') {
  return {
    status: () => ({ state, desktops: 0 }),
    runningGuest: () => {
      throw new Error('VM not running')
    },
    subscribe: () => () => undefined,
  } as unknown as ConstructorParameters<typeof KnowledgeService>[0]['vm']
}

export function knowledgeService(
  t: KnowledgeTest,
  extra: Partial<ConstructorParameters<typeof KnowledgeService>[0]> = {},
) {
  const { db, now } = t
  const store = new WorkspaceStore(db, now)
  const chief = store.bots.create({ name: 'Chief' })
  const ana = store.bots.create({ name: 'Ana' })
  const docs = new KnowledgeStore(db, now)
  const knowledge = new KnowledgeService({
    docs,
    store,
    projects: { exists: () => false, ofConversation: () => null },
    workspaceDir: '/nonexistent/milibot-test',
    vm: vmStub(),
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
      createProvider: async (setting) =>
        new FakeEmbeddingProvider({
          key: `fake:${setting.provider === 'local' ? setting.level : setting.model}`,
        }),
      now,
      log: () => undefined,
    }),
    modelsDir: null,
    now,
    thresholds: { suggestMinScore: 0.2, chunkMinScore: 0.2 },
    ...extra,
  })
  return { knowledge, store, chief, ana }
}
