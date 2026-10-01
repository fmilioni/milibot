import { FakeEmbeddingProvider } from '@milibot/agent/embeddings'
import { describe, expect, it } from 'vitest'

import { ACTIVE_SPACE_KEY, EmbeddingService } from '../../../src/runtime/embeddings/service'
import { knowledgeCorpus } from '../../../src/runtime/knowledge/corpus'
import { hybridSearch } from '../../../src/runtime/knowledge/search'
import { addDoc, embeddingService, knowledgeTest, makeStore } from '../knowledge/fixtures'

const t = knowledgeTest()

describe('embedding service', () => {
  it('switches the active space only once the new model indexed everything', async () => {
    const store = makeStore(t)
    const a = addDoc(store, 'Manual', 'How to set up the office printer.')
    const b = addDoc(store, 'Policy', 'Vacations must be requested thirty days in advance.')
    const embeddings = embeddingService(t, store)
    t.settings.set('knowledge.embedding', { provider: 'local', family: 'embeddinggemma', level: 'max' })
    await embeddings.embedDocument(a.id)
    await embeddings.embedDocument(b.id)
    expect(embeddings.active()?.space).toBe('fake:max')

    t.settings.set('knowledge.embedding', { provider: 'local', family: 'multilingual-e5', level: 'small' })
    expect(embeddings.status().targetSpace).not.toBe('fake:max')
    embeddings.schedule()
    await embeddings.whenIdle()
    expect(t.settings.get(ACTIVE_SPACE_KEY)).toMatchObject({ space: 'fake:small' })
    expect(store.vectorCount('fake:max')).toBe(0)
    expect(store.vectorCount('fake:small')).toBe(store.totalChunks())
    expect(embeddings.status().state).toBe('idle')
  })

  it('reports an unavailable model and keeps text search working', async () => {
    const store = makeStore(t)
    const doc = addDoc(store, 'Manual', 'How to set up the office printer.')
    const embeddings = embeddingService(t, store, () => {
      throw Object.assign(new Error('offline'), { code: 'model_download_failed' })
    })
    expect(await embeddings.embedDocument(doc.id)).toBe(false)
    expect(embeddings.status()).toMatchObject({ state: 'unavailable', error: { message: 'offline' } })
    const outcome = await hybridSearch(
      { store, embeddings, readContent: () => null },
      { query: 'printer', topK: 3, botId: null, vector: { timeoutMs: 100, loadModel: true } },
    )
    expect(outcome.mode).toBe('text')
    expect(outcome.hits.map((h) => h.docId)).toEqual([doc.id])
    embeddings.stop()
  })
  it('sizes chunks by the longest input registered for an API model', () => {
    t.settings.set('knowledge.embedding', { provider: 'api', providerId: 'prov_1', model: 'baai/bge-m3' })
    const service = new EmbeddingService({
      chunks: knowledgeCorpus(makeStore(t)),
      getSetting: <T>(key: string, fallback: T) =>
        t.settings.has(key) ? (t.settings.get(key) as T) : fallback,
      setSetting: (key, value) => t.settings.set(key, value),
      createProvider: async () => new FakeEmbeddingProvider(),
      apiMaxInputTokens: (providerId, model) =>
        providerId === 'prov_1' && model === 'baai/bge-m3' ? 512 : null,
      now: t.now,
      log: () => undefined,
    })
    expect(service.maxInputTokens()).toBe(512)
    t.settings.set('knowledge.embedding', { provider: 'api', providerId: 'prov_1', model: 'other/model' })
    expect(service.maxInputTokens()).toBe(8192)
  })
})
