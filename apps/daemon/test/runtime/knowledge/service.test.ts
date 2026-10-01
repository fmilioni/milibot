import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { originalPath } from '../../../src/runtime/knowledge/files'
import { removeDir, tempDir } from '../../support/temp'
import { addDoc, knowledgeService, knowledgeTest } from './fixtures'

const t = knowledgeTest()

describe('knowledge context', () => {
  it('catalog: header with the count and pinned documents within the budget', () => {
    const { knowledge, chief, ana } = knowledgeService(t)
    expect(knowledge.catalog(chief)).toBe('')
    for (let i = 0; i < 12; i++)
      addDoc(knowledge.docs, `Document ${i}`, `Content ${i}`, {
        pinned: i < 11,
        summary: `Summary of document ${i}. A second sentence that is left out.`,
      })
    addDoc(knowledge.docs, "Ana's own", 'secret', { scope: [ana.id], pinned: true })
    const catalog = knowledge.catalog(chief)
    expect(catalog).toMatch(/^# Knowledge base\n12 general documents/)
    expect(catalog).toContain('- Document 0 (markdown) — Summary of document 0.')
    expect(catalog).not.toContain("Ana's own")
    expect(knowledge.catalog(ana)).toMatch(/^# Knowledge base\n13 general documents/)
    const tokens = Math.ceil(catalog.length / 3.5)
    expect(tokens).toBeLessThanOrEqual(400)
    expect(catalog).toMatch(/\(\d+ more pinned: knowledge_list\)$/)

    t.db
      .prepare(
        "INSERT INTO settings (key, value, updated_at) VALUES ('knowledge.catalog_budget_tokens', '0', 1)",
      )
      .run()
    expect(knowledge.catalog(chief)).toBe('')
  })

  it('suggests documents close to the input and, when enabled, excerpts', async () => {
    const { knowledge, chief } = knowledgeService(t)
    const contract = addDoc(
      knowledge.docs,
      'Rent contract',
      'The rent is due on the fifth. A fine of two percent.',
      {
        summary: 'Office rent contract: due date, fine for late payment and adjustment.',
      },
    )
    addDoc(knowledge.docs, 'Cake recipe', 'Flour, eggs and cocoa.', {
      summary: 'Chocolate cake recipe with frosting.',
    })
    for (const id of knowledge.docs.ids({})) await knowledge.embeddings.embedDocument(id)
    const signal = new AbortController().signal
    const block = await knowledge.forTurn(chief, 'what is the fine for late rent?', signal)
    expect(block).toContain('[Milibot knowledge] Documents that may be relevant')
    expect(block).toContain(`Rent contract (markdown, ${contract.id})`)
    expect(block).not.toContain('Cake recipe')
    expect(block).not.toContain('Excerpts')

    knowledge.updateSettings({ autoRetrieve: true, suggestDocs: false })
    const excerpts = await knowledge.forTurn(chief, 'what is the fine for late rent?', signal)
    expect(excerpts).toContain('Excerpts that may be relevant')
    expect(excerpts).toContain('A fine of two percent')
    expect(knowledge.docs.row(contract.id).last_used_at).not.toBeNull()

    knowledge.updateSettings({ autoRetrieve: false })
    expect(await knowledge.forTurn(chief, 'what is the fine for late rent?', signal)).toBe('')
  })

  it('with vectors, a text-only suggestion for a prose message needs one more shared term', async () => {
    const { knowledge, chief } = knowledgeService(t, { thresholds: { suggestMinScore: 0.99 } })
    addDoc(knowledge.docs, 'Travel policy', 'Travel rules.', {
      summary: 'Meal and lodging allowances on business trips.',
    })
    for (const id of knowledge.docs.ids({})) await knowledge.embeddings.embedDocument(id)
    const signal = new AbortController().signal
    const suggested = async (text: string) =>
      (await knowledge.forTurn(chief, text, signal)).includes('Travel policy')
    expect(await suggested('how much is the lodging allowance?')).toBe(false)
    expect(await suggested('what is the lodging allowance on a business trip?')).toBe(true)
    expect(await suggested('lodging allowance for cost center CC-310')).toBe(true)
  })
})

describe('knowledge export', () => {
  it('names the host copy safely, whatever the VM called the file', async () => {
    const root = tempDir('knowledge-export')
    try {
      const { knowledge } = knowledgeService(t, {
        workspaceDir: join(root, 'ws'),
        exportDir: join(root, 'exports'),
      })
      const doc = addDoc(knowledge.docs, 'Startup', 'echo hi', {
        fileName: '..\\..\\AppData\\Roaming\\Startup\\CON.bat',
      })
      const source = originalPath(join(root, 'ws'), doc.id, '..\\..\\AppData\\Roaming\\Startup\\CON.bat')
      mkdirSync(dirname(source), { recursive: true })
      writeFileSync(source, 'echo hi')
      const exported = await knowledge.export(doc.id)
      expect(exported.fileName).toBe('_CON.bat')
      expect(exported.path).toBe(join(root, 'exports', doc.id, '_CON.bat'))
      expect(readFileSync(exported.path, 'utf8')).toBe('echo hi')
    } finally {
      removeDir(root)
    }
  })
})
