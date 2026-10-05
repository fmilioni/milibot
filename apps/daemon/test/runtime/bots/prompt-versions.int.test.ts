import type { DefaultAgentHost } from '@milibot/agent'
import type { CompletionRequest } from '@milibot/agent/llm'
import type { FakeProvider, FakeStep } from '@milibot/agent/testing'
import type { Bot, MemoryNote, Message, PromptVersion } from '@milibot/shared'
import { PERSONA_MAX_TOKENS } from '@milibot/shared'
import { afterEach, describe, expect, it } from 'vitest'

import type { WorkspaceRuntime } from '../../../src/runtime/runtime'
import { bootRuntime, type RuntimeHarness, stopRuntimes } from '../../support/runtime-harness'
import { useTempDir } from '../../support/temp'

let h: RuntimeHarness
let runtime: WorkspaceRuntime
let host: DefaultAgentHost
let provider: FakeProvider
let anaId: string
let anaDm: string

const dir = useTempDir('evolution')
afterEach(stopRuntimes)

type Script = (request: CompletionRequest, index: number) => FakeStep

async function boot(script: Script) {
  h = await bootRuntime({ dir: dir(), vm: false, script })
  ;({ runtime, host, provider } = h)
  const ana = runtime.store.bots.create({
    name: 'Ana',
    label: 'Finance',
    systemPrompt: 'You are Ana. You track expenses.',
  })
  anaId = ana.id
  anaDm = runtime.store.conversations.create({ type: 'direct', botIds: [ana.id] }).id
}

const call: RuntimeHarness['call'] = (...args) => h.call(...args)

async function say(content: string, conversationId = anaDm) {
  await call('postMessage', { conversationId }, { content })
  await host.idle()
}

const messages = async (conversationId = anaDm) =>
  (await call<{ messages: Message[] }>('listMessages', { conversationId }, undefined, { limit: 100 }))
    .messages

const ana = () => runtime.store.bots.list().find((b) => b.id === anaId) as Bot

const toolResults = (request: CompletionRequest | undefined) =>
  (request?.messages ?? [])
    .filter((m) => m.role === 'tool')
    .flatMap((m) => m.content.map((p) => (p.type === 'text' ? p.text : '')))

/** Ana calls `tool` with `args` on each user message, then answers "ok". */
function toolThenReply(tool: string, args: (i: number) => Record<string, unknown>): Script {
  let turn = 0
  return (request) => {
    const last = request.messages.at(-1)
    if (last?.role === 'tool') return { text: 'ok' }
    return { toolCalls: [{ name: tool, arguments: args(turn++) }] }
  }
}

describe('evolving prompts', () => {
  it('update_own_prompt applies the change, versions it, posts a card and can be undone', async () => {
    await boot(
      toolThenReply('update_own_prompt', () => ({
        patch: [
          {
            old_text: 'You track expenses.',
            new_text: 'You track expenses, accounts payable and cash flow.',
          },
        ],
        reason: 'The user asked me to also handle accounts payable and cash flow.',
      })),
    )
    await say('You will also handle accounts payable and cash flow.')

    expect(ana().systemPrompt).toBe('You are Ana. You track expenses, accounts payable and cash flow.')
    const versions = await call<PromptVersion[]>('listPromptVersions', { botId: anaId })
    expect(versions.map((v) => [v.authorType, v.current])).toEqual([
      ['bot', true],
      ['system', false],
    ])
    expect(versions[0]).toMatchObject({ authorBotId: anaId, added: 1, removed: 1 })
    expect(versions[0]?.diff).toContain('+You are Ana. You track expenses, accounts payable and cash flow.')

    const card = (await messages()).find((m) => m.payload?.type === 'prompt_updated')
    expect(card?.payload).toMatchObject({
      type: 'prompt_updated',
      botId: anaId,
      authorBotId: anaId,
      added: 1,
    })

    // The next request carries the new persona.
    await say('hi')
    const system = provider.requests.at(-1)?.messages[0]
    expect(JSON.stringify(system)).toContain('accounts payable and cash flow')

    const restored = await call<PromptVersion>('undoPromptVersion', { versionId: versions[0]?.id as string })
    expect(restored.text).toBe('You are Ana. You track expenses.')
    expect(ana().systemPrompt).toBe('You are Ana. You track expenses.')
    const undone = (await messages()).find((m) => m.id === card?.id)
    expect(undone?.payload).toMatchObject({ undone: true })
    expect((await call<PromptVersion[]>('listPromptVersions', { botId: anaId }))[0]).toMatchObject({
      authorType: 'user',
      current: true,
    })
  })

  it('refuses to undo a change that later edits built on', async () => {
    await boot(
      toolThenReply('update_own_prompt', () => ({
        patch: [{ old_text: '', new_text: 'Report monthly.' }],
        reason: 'The user asked for monthly reports.',
      })),
    )
    await say('Send me a report every month.')
    const [changed] = await call<PromptVersion[]>('listPromptVersions', { botId: anaId })
    await call('updateBot', { botId: anaId }, { systemPrompt: `${ana().systemPrompt}\nUse tables.` })
    await expect(call('undoPromptVersion', { versionId: changed?.id as string })).rejects.toMatchObject({
      code: 'conflict',
    })
    expect(ana().systemPrompt).toBe('You are Ana. You track expenses.\nReport monthly.\nUse tables.')
  })

  it('refuses a persona over the cap with a message asking to consolidate', async () => {
    const huge = 'Always double-check every number and write it down in the ledger. '.repeat(90)
    await boot(toolThenReply('update_own_prompt', () => ({ new_persona: huge, reason: 'more detail' })))
    await say('be more detailed')
    const result = toolResults(provider.requests.at(-1)).join('\n')
    expect(result).toContain(`over the limit of ${PERSONA_MAX_TOKENS}`)
    expect(result).toContain('memory_save')
    expect(ana().systemPrompt).toBe('You are Ana. You track expenses.')
  })

  it('allows one change per turn and a few per day unless the user asked', async () => {
    let n = 0
    await boot((request) => {
      const last = request.messages.at(-1)
      const results = toolResults(request)
      if (last?.role === 'tool' && results.length >= 2) return { text: 'ok' }
      return {
        toolCalls: [
          {
            name: 'update_own_prompt',
            arguments: { patch: [{ old_text: '', new_text: `Rule ${++n}.` }], reason: 'r' },
          },
        ],
      }
    })
    await say('first')
    const first = toolResults(provider.requests.at(-1))
    expect(first[0]).toContain('Updated your role section')
    expect(first[1]).toContain('already changed this prompt in this turn')
    await say('second')
    await say('third')
    await say('fourth')
    expect(toolResults(provider.requests.at(-1))[0]).toContain('3 times in the last 24 hours')
    expect(ana().systemPrompt).toBe('You are Ana. You track expenses.\nRule 1.\nRule 3.\nRule 5.')
  })

  it('in approval mode the change waits for the confirmation card', async () => {
    await boot(
      toolThenReply('update_own_prompt', () => ({
        new_persona: 'You are Ana. You own the whole finance area.',
        reason: 'The user expanded my role to all of finance.',
      })),
    )
    await call('updateWorkspacePreferences', {}, { promptUpdates: 'approval' })
    await say('Now you own the whole finance area.')
    expect(ana().systemPrompt).toBe('You are Ana. You track expenses.')
    const card = (await messages()).find((m) => m.payload?.type === 'confirmation')
    if (card?.payload?.type !== 'confirmation') throw new Error('expected a confirmation card')
    expect(card.payload).toMatchObject({ action: 'update_prompt', status: 'pending' })
    expect(card.payload.params).toMatchObject({ botName: 'Ana', added: '1', removed: '1' })
    expect(card.payload.params?.text).toBeUndefined()

    await call('resolveConfirmation', { confirmationId: card.payload.confirmationId }, { approved: true })
    expect(ana().systemPrompt).toBe('You are Ana. You own the whole finance area.')
    expect((await call<PromptVersion[]>('listPromptVersions', { botId: anaId }))[0]).toMatchObject({
      authorType: 'bot',
      reason: 'The user expanded my role to all of finance.',
    })
  })

  it('user edits in bot settings become versions that can be restored', async () => {
    await boot(() => ({ text: 'ok' }))
    await call('updateBot', { botId: anaId }, { systemPrompt: 'You are Ana, the CFO.' })
    const versions = await call<PromptVersion[]>('listPromptVersions', { botId: anaId })
    expect(versions.map((v) => v.authorType)).toEqual(['user', 'system'])
    await call('restorePromptVersion', { botId: anaId, versionId: versions[1]?.id as string })
    expect(ana().systemPrompt).toBe('You are Ana. You track expenses.')
  })
})

describe('workspace memory', () => {
  it('memory_save with scope workspace reaches every bot as its own cached block', async () => {
    await boot(
      toolThenReply('memory_save', () => ({
        note: 'The user lives in Brazil and uses reais (R$) with a decimal comma.',
        scope: 'workspace',
      })),
    )
    await say('I live in Brazil and use reais.')
    const notes = await call<MemoryNote[]>('listWorkspaceMemories')
    expect(notes.map((n) => [n.scope, n.botId])).toEqual([['workspace', null]])
    expect(await call<MemoryNote[]>('listBotMemories', { botId: anaId })).toEqual([])

    const chief = runtime.store.bots.first() as Bot
    const chiefDm = runtime.store.conversations.findDirect(chief.id)?.id as string
    await say('hi', chiefDm)
    const system = provider.requests.at(-1)?.messages[0]
    const parts = system?.content ?? []
    expect(parts[1]).toMatchObject({ type: 'text', cacheBreakpoint: true })
    expect(parts[1]?.type === 'text' && parts[1].text).toContain('# Workspace memory')
    expect(parts[1]?.type === 'text' && parts[1].text).toContain('R$')
  })

  it('refuses near-duplicates and updates a note in place with replaces', async () => {
    const steps: FakeStep[] = [
      {
        toolCalls: [
          {
            name: 'memory_save',
            arguments: { note: 'The user prefers dates as DD/MM/YYYY.', scope: 'workspace' },
          },
        ],
      },
      { text: 'ok' },
      {
        toolCalls: [
          {
            name: 'memory_save',
            arguments: { note: 'The user prefers dates as DD/MM/YYYY!', scope: 'workspace' },
          },
        ],
      },
      { text: 'ok' },
      {
        toolCalls: [
          {
            name: 'memory_save',
            arguments: { note: 'The user prefers ISO dates (YYYY-MM-DD).', replaces: 'dates as DD/MM/YYYY' },
          },
        ],
      },
      { text: 'ok' },
    ]
    await boot((_request, i) => steps[i] ?? { text: 'ok' })
    await say('one')
    await say('two')
    expect(toolResults(provider.requests.at(-1))[0]).toMatch(/Already in workspace memory|very similar note/)
    await say('three')
    const notes = await call<MemoryNote[]>('listWorkspaceMemories')
    expect(notes.map((n) => n.content)).toEqual(['The user prefers ISO dates (YYYY-MM-DD).'])
  })

  it('a bot merges repeated workspace notes and forgets an outdated one; other bots see only the result', async () => {
    const steps: FakeStep[] = [
      {
        toolCalls: [
          {
            name: 'memory_save',
            arguments: {
              note: 'Never write comments on GitHub PRs.',
              replaces: ['Never comment on PRs.', 'No PR comments, not even reviews.'],
            },
          },
        ],
      },
      {
        toolCalls: [
          {
            name: 'memory_forget',
            arguments: { notes: 'Exceptions valid for 0.3', reason: 'Version 0.3 is over.' },
          },
        ],
      },
      { text: 'ok' },
    ]
    await boot((_request, i) => steps[i] ?? { text: 'ok' })
    for (const content of [
      'Never comment on PRs.',
      'Exceptions valid for 0.3 only.',
      'No PR comments, not even reviews.',
    ])
      await call('createWorkspaceMemory', {}, { content })
    const [first] = await call<MemoryNote[]>('listWorkspaceMemories')

    await say('Tidy up the memory.')
    const notes = await call<MemoryNote[]>('listWorkspaceMemories')
    expect(notes.map((n) => [n.id, n.content])).toEqual([[first?.id, 'Never write comments on GitHub PRs.']])
    const activity = (await messages()).find((m) => m.kind === 'activity')
    expect(activity?.content).toContain('Exceptions valid for 0.3 only.')
    expect(activity?.content).toContain('Version 0.3 is over.')

    const chief = runtime.store.bots.first() as Bot
    const chiefDm = runtime.store.conversations.findDirect(chief.id)?.id as string
    await say('hi', chiefDm)
    const system = provider.requests.at(-1)?.messages[0]
    const block = system?.content[1]
    const text = block?.type === 'text' ? block.text : ''
    expect(text).toContain('Never write comments on GitHub PRs.')
    expect(text).not.toContain('Never comment on PRs.')
    expect(text).not.toContain('not even reviews')
    expect(text).not.toContain('0.3')
  })

  it('workspace notes are managed through their own routes', async () => {
    await boot(() => ({ text: 'ok' }))
    const note = await call<MemoryNote>('createWorkspaceMemory', {}, { content: 'The team uses Notion.' })
    expect(note).toMatchObject({ scope: 'workspace', botId: null, pinned: true })
    await call(
      'updateWorkspaceMemory',
      { memoryId: note.id },
      { content: 'The team uses Notion and Linear.' },
    )
    await expect(call('deleteBotMemory', { botId: anaId, memoryId: note.id })).rejects.toThrow()
    await call('deleteWorkspaceMemory', { memoryId: note.id })
    expect(await call<MemoryNote[]>('listWorkspaceMemories')).toEqual([])
  })

  it('seeds no note: a new workspace starts with an empty workspace memory', async () => {
    await boot(() => ({ text: 'ok' }))
    expect(await call<MemoryNote[]>('listWorkspaceMemories')).toEqual([])
  })
})
