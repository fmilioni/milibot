import { lexicalQueryWeight } from '@milibot/agent/embeddings'
import { describe, expect, it } from 'vitest'

import { formatHits, hybridSearch } from '../../../src/runtime/knowledge/search'
import { addDoc, embeddingService, knowledgeTest, makeStore } from './fixtures'

const t = knowledgeTest()

describe('hybrid search', () => {
  it('fuses text and vectors, merges neighbouring chunks and falls back to text only', async () => {
    const store = makeStore(t)
    const contract = addDoc(
      store,
      'Contract',
      [
        '# Payment',
        'The monthly rent is due on the fifth and is paid by bank slip.',
        'Late payment of the rent incurs a fine of two percent.',
        '# Adjustment',
        'The amount is adjusted yearly by the IGP-M index in January.',
      ].join('\n\n'),
    )
    addDoc(store, 'Recipe', 'Chocolate cake: mix flour, eggs and cocoa; bake for forty minutes.')
    const contents = new Map([[contract.id, contract.content]])
    const embeddings = embeddingService(t, store)
    const deps = { store, embeddings, readContent: (id: string) => contents.get(id) ?? null }

    const textOnly = await hybridSearch(deps, {
      query: 'fine for late rent payment',
      topK: 3,
      botId: null,
      vector: { timeoutMs: 1000, loadModel: true },
    })
    expect(textOnly.mode).toBe('text')
    expect(textOnly.hits[0]?.docId).toBe(contract.id)

    for (const id of store.ids({})) await embeddings.embedDocument(id)
    const hybrid = await hybridSearch(deps, {
      query: 'fine for late rent payment',
      topK: 3,
      botId: null,
      vector: { timeoutMs: 1000, loadModel: true },
    })
    expect(hybrid.mode).toBe('hybrid')
    const top = hybrid.hits[0]!
    expect(top.docId).toBe(contract.id)
    expect(top.text).toContain('fine')
    expect(top.vectorRank).not.toBeNull()
    // Neighbouring chunks of the same document come back as one hit, without repeating the overlap.
    const merged = hybrid.hits.find((h) => h.toChunk > h.fromChunk)
    if (merged) expect(merged.text.split('Late payment').length).toBeLessThanOrEqual(2)

    const text = formatHits(hybrid.hits)
    expect(text).toMatch(new RegExp(`^\\[1\\] Contract · Payment \\(${contract.id}, chunks? `))
    expect(lexicalQueryWeight('adjustment IGP-M 2024')).toBe(1)
  })

  it('keeps a hit on the matching chunk instead of merging unrelated neighbours', async () => {
    const store = makeStore(t)
    const sections = [
      ['Cleaning', 'The cleaning crew mops the hall on Mondays and sweeps the sidewalk every morning.'],
      [
        'Oven',
        'The industrial oven heats up to two hundred degrees and the conveyor needs oil every thirty days.',
      ],
      ['Warranty', 'The equipment warranty covers factory defects for twelve months from the invoice.'],
      ['Delivery', 'The flour truck arrives on Thursdays and receiving checks weight and expiry dates.'],
    ]
    const manual = addDoc(store, 'Manual', sections.map(([h, t]) => `# ${h}\n\n${t}`).join('\n\n'))
    const embeddings = embeddingService(t, store)
    await embeddings.embedDocument(manual.id)
    const deps = { store, embeddings, readContent: () => manual.content }
    const { hits } = await hybridSearch(deps, {
      query: 'industrial oven conveyor oil heats degrees',
      topK: 3,
      botId: null,
      vector: { timeoutMs: 1000, loadModel: true },
    })
    const top = hits[0]!
    expect(top.heading).toContain('Oven')
    expect(top.text).toContain('conveyor')
    expect(top.text).not.toContain('truck')
    expect(top.toChunk - top.fromChunk).toBeLessThan(2)
  })
})
