import type { Bot } from '@milibot/shared'
import { describe, expect, it } from 'vitest'

import { DaemonError } from '../../../src/errors'
import { KnowledgeTools } from '../../../src/runtime/knowledge/tools'
import { addDoc, knowledgeService, knowledgeTest } from './fixtures'

const t = knowledgeTest()

describe('knowledge tools', () => {
  it('searches, lists and refuses what a bot may not change', async () => {
    const { knowledge, chief, ana } = knowledgeService(t)
    const tools = new KnowledgeTools({ service: knowledge, botName: (id) => (id === ana.id ? 'Ana' : null) })
    const ctx = (bot: Bot) => ({
      bot,
      conversationId: null,
      turnId: null,
      signal: new AbortController().signal,
    })
    const run = async (bot: Bot, name: string, args: Record<string, unknown>) => {
      const result = await tools.execute(ctx(bot), { id: 't', name, arguments: args })
      return { text: result.content.map((p) => (p.type === 'text' ? p.text : '')).join(''), result }
    }
    const contract = addDoc(knowledge.docs, 'Contract', 'The rent is due on the fifth.', {
      summary: 'Office rent contract.',
    })
    const runbook = addDoc(knowledge.docs, 'Runbook', 'Restart the server carefully.', {
      source: 'bot',
      authorType: 'bot',
      authorBotId: ana.id,
      kind: 'note',
    })

    const search = await run(chief, 'knowledge_search', { query: 'when is the rent due' })
    expect(search.text).toContain(`[1] Contract (${contract.id}, chunk 1)`)
    expect(search.result.activity?.detail).toBe('when is the rent due')

    const list = await run(chief, 'knowledge_list', {})
    expect(list.text).toMatch(/^Page 1 of 1 \(2 documents\)\./)
    expect(list.text).toContain('by user')
    expect(list.text).toContain('by Ana')
    const byAuthor = await run(chief, 'knowledge_list', { author: 'Ana' })
    expect(byAuthor.text).toContain('Runbook')
    expect(byAuthor.text).not.toContain('Contract')

    const deleteUser = await run(ana, 'knowledge_delete', { doc: contract.id })
    expect(deleteUser.result.isError).toBe(true)
    expect(deleteUser.text).toContain('added by the user')
    const deleteOther = await run(chief, 'knowledge_delete', { doc: 'Runbook' })
    expect(deleteOther.result.isError).toBe(true)
    const editUser = await run(ana, 'knowledge_edit', { doc: 'Contract', old_text: 'a', new_text: 'b' })
    expect(editUser.result.isError).toBe(true)
    const missing = await run(ana, 'knowledge_read', { doc: 'none of this' })
    expect(missing.text).toContain('No document matches')
    expect(runbook.id).toMatch(/^kdoc_/)
  })
})

describe('knowledge tool errors', () => {
  it('keeps the host paths of unexpected errors away from the bot', async () => {
    const { knowledge, chief } = knowledgeService(t)
    const tools = new KnowledgeTools({ service: knowledge, botName: () => null })
    const add = async () => {
      const result = await tools.execute(
        { bot: chief, conversationId: null, turnId: null, signal: new AbortController().signal },
        { id: 't', name: 'knowledge_add', arguments: { path: '/workspace/a.pdf' } },
      )
      return {
        isError: result.isError,
        text: result.content.map((p) => (p.type === 'text' ? p.text : '')).join(''),
      }
    }
    knowledge.addFromVm = async () => {
      throw Object.assign(new Error("ENOENT: no such file or directory, open '/Users/me/ws/x'"), {
        code: 'ENOENT',
      })
    }
    expect(await add()).toEqual({ isError: true, text: 'The knowledge base could not do this (ENOENT).' })
    knowledge.addFromVm = async () => {
      throw new DaemonError('validation_failed', 'The path must be a file under /workspace')
    }
    expect(await add()).toEqual({ isError: true, text: 'The path must be a file under /workspace' })
    knowledge.addFromVm = async () => {
      throw new TypeError('boom')
    }
    await expect(add()).rejects.toThrow('boom')
  })
})
