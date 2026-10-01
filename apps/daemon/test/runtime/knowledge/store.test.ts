import { describe, expect, it } from 'vitest'

import { chunkContent } from '../../../src/runtime/knowledge/chunker'
import { WorkspaceStore } from '../../../src/runtime/workspace-store'
import { addDoc, embeddingService, knowledgeTest, makeStore, paragraphs } from './fixtures'

const t = knowledgeTest()

describe('KnowledgeStore', () => {
  it('stores documents, chunks with FTS, bot scope and cascades', () => {
    const store = makeStore(t)
    const bots = new WorkspaceStore(t.db, t.now)
    const ana = bots.bots.create({ name: 'Ana' })
    const leo = bots.bots.create({ name: 'Leo' })
    const shared = addDoc(store, 'Contract', 'The rent is due on the fifth.')
    const privateDoc = addDoc(store, 'Café journal', 'Notes about the résumé review meeting.', {
      scope: [ana.id],
    })
    expect(store.ids({ botId: ana.id }).sort()).toEqual([shared.id, privateDoc.id].sort())
    expect(store.ids({ botId: leo.id })).toEqual([shared.id])
    expect(store.countVisible(leo.id)).toBe(1)

    expect(store.searchChunks('"resume"', null, 10).map((h) => h.docId)).toEqual([privateDoc.id])
    expect(store.searchChunks('"rent"', [privateDoc.id], 10)).toEqual([])
    expect(store.searchDocs('"cafe"', {}, 10)).toEqual([privateDoc.id])

    store.delete(shared.id)
    expect(store.chunks(shared.id)).toEqual([])
    expect(store.searchChunks('"rent"', null, 10)).toEqual([])
  })

  it('reuses the vector of a chunk whose text did not change', async () => {
    const store = makeStore(t)
    const steps = ['Stop the queue service', 'Run the database migration', 'Start the service again']
    const text = (last: string) =>
      [...steps.slice(0, 2), last]
        .map((s) => `## ${s}\n\n${paragraphs(s.split(' ')[1]!, 1, 25)}`)
        .join('\n\n')
    const doc = addDoc(store, 'Runbook', text(steps[2]!))
    const embeddings = embeddingService(t, store)
    expect(await embeddings.embedDocument(doc.id)).toBe(true)
    const space = embeddings.active()!.space
    const options = { targetTokens: 40, maxTokens: 80 }
    expect(store.vectorCount(space)).toBe(store.chunks(doc.id).length)
    const same = chunkContent(doc.content, options)
    expect(store.replaceChunks(doc.id, same).reused).toBe(same.length)
    expect(store.countChunksToEmbed(space, doc.id)).toBe(0)
    const changed = chunkContent(text('Check the service logs'), options)
    const { reused } = store.replaceChunks(doc.id, changed)
    expect(reused).toBeGreaterThan(0)
    expect(store.countChunksToEmbed(space, doc.id)).toBe(changed.length - reused)
    expect(changed.length - reused).toBeGreaterThan(0)
  })
})
