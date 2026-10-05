import type { DefaultAgentHost } from '@milibot/agent'
import type { CompletionRequest } from '@milibot/agent/llm'
import { TRIAGE_SYSTEM_PROMPT } from '@milibot/agent/prompts'
import type { FakeStep } from '@milibot/agent/testing'
import type { ConversationSummary, Message, StepDiff, WorkspaceEvent } from '@milibot/shared'
import { afterEach, describe, expect, it } from 'vitest'

import type { WorkspaceRuntime } from '../../../src/runtime/runtime'
import type { MemorySecretStore } from '../../../src/secrets/secret-store'
import type { FakeGuest } from '../../support/fake-guest'
import { bootRuntime, type RuntimeHarness, stopRuntimes } from '../../support/runtime-harness'
import { useTempDir } from '../../support/temp'
import { until } from '../../support/wait'

let h: RuntimeHarness
let runtime: WorkspaceRuntime
let host: DefaultAgentHost
let events: WorkspaceEvent[]
let guest: FakeGuest
let secrets: MemorySecretStore
let chiefId: string
let chiefDm: string

const dir = useTempDir('agent')
afterEach(stopRuntimes)

type Script = FakeStep[] | ((tools: number, i: number, request: CompletionRequest) => FakeStep)

async function boot(script: Script) {
  let chiefCalls = 0
  h = await bootRuntime({
    dir: dir(),
    script:
      typeof script === 'function'
        ? (request) => script(request.tools.length, request.tools.length ? chiefCalls++ : 0, request)
        : script,
  })
  ;({ runtime, host, events, guest, secrets, botId: chiefId, dm: chiefDm } = h)
  return { provider: h.provider, vm: h.vm! }
}

const call: RuntimeHarness['call'] = (...args) => h.call(...args)

describe('agent runtime (fake LLM + fake VM)', () => {
  it('runs a computer + bash turn end to end with logging and events', async () => {
    await boot([
      {
        text: 'Opening the terminal.',
        toolCalls: [{ name: 'computer', arguments: { action: 'screenshot' } }],
      },
      { toolCalls: [{ name: 'computer', arguments: { action: 'click', x: 708, y: 772 } }] },
      { toolCalls: [{ name: 'bash', arguments: { command: 'echo hello' } }] },
      { text: 'Terminal open and command run.' },
    ])
    expect(guest.state.provisioned).toEqual([{ slug: 'maestro', uid: 2001, display: 1 }])

    await call('postMessage', { conversationId: chiefDm }, { content: 'open the terminal' })
    await host.idle()

    const page = await call<{ messages: Message[] }>('listMessages', { conversationId: chiefDm }, undefined, {
      limit: 50,
    })
    // The narration before the first tool call left the chat for the activity card.
    expect(page.messages.map((m) => [m.authorType, m.kind])).toEqual([
      ['user', 'text'],
      ['bot', 'activity'],
      ['bot', 'text'],
    ])
    expect(page.messages[2]?.content).toBe('Terminal open and command run.')
    const activity = page.messages[1]?.payload
    if (activity?.type !== 'activity') throw new Error('expected activity')
    expect(activity.steps.map((s) => [s.kind, s.detail, s.status])).toEqual([
      ['note', 'Opening the terminal.', 'ok'],
      ['screenshot', '', 'ok'],
      ['click', '(708, 772)', 'ok'],
      ['bash', 'echo hello', 'ok'],
    ])

    expect(guest.state.inputs).toEqual([{ display: 1, actions: [{ type: 'click', x: 708, y: 772 }] }])
    expect(guest.state.execs.find((e) => e.user === 'bot-maestro')).toMatchObject({
      cmd: 'echo hello',
      cwd: '/workspace',
    })
    // The guest agent owns the VM's helper scripts: the daemon never pushes them.
    expect(
      guest.state.execs.some((e) => /milibot-(gh|cli)-wrapper|DevTools port/.test(String(e.stdin))),
    ).toBe(false)

    const llmCalls = await call<Array<{ purpose: string; request: unknown; model: string }>>(
      'listLlmCalls',
      { conversationId: chiefDm },
      undefined,
      { limit: 50 },
    )
    expect(llmCalls).toHaveLength(4)
    expect(llmCalls[1]?.request && JSON.stringify(llmCalls[1].request)).toMatch(/"sha256":"[0-9a-f]{64}"/)
    // Each call reaches the debug panel as soon as it is recorded, not when the turn ends.
    const recorded = events.flatMap((e) =>
      e.type === 'llm_call.recorded' && e.payload.conversationId === chiefDm ? [e.payload.callId] : [],
    )
    expect(recorded).toEqual((llmCalls as Array<{ id?: string }>).map((c) => c.id))
    const toolCalls = await call<Array<{ toolName: string; status: string; screenshotSha: string | null }>>(
      'listToolCalls',
      { conversationId: chiefDm },
      undefined,
      { limit: 50 },
    )
    expect(toolCalls.map((t) => [t.toolName, t.status])).toEqual([
      ['computer', 'ok'],
      ['computer', 'ok'],
      ['bash', 'ok'],
    ])
    const blob = await call<{ mediaType: string; data: string }>('getBlob', {
      sha: toolCalls[0]?.screenshotSha as string,
    })
    expect(blob.mediaType).toBe('image/png')
    expect(Buffer.from(blob.data, 'base64').subarray(1, 4).toString()).toBe('PNG')

    const activityLog = await call<Array<{ kind: string }>>('getBotActivity', { botId: chiefId }, undefined, {
      limit: 10,
    })
    expect(activityLog.map((a) => a.kind)).toEqual(['bash', 'click', 'screenshot'])

    const types = new Set(events.map((e) => e.type))
    for (const type of [
      'vm.status',
      'message.created',
      'message.delta',
      'message.updated',
      'bot.status',
      'bot.activity',
    ]) {
      expect(types).toContain(type)
    }
    const statuses = events.flatMap((e) => (e.type === 'bot.status' ? [e.payload.status] : []))
    expect(statuses).toEqual(expect.arrayContaining(['thinking', 'talking', 'working', 'idle']))
  })

  it('shows the files a step changed and serves each step diff', async () => {
    await boot([
      { toolCalls: [{ name: 'file_write', arguments: { path: 'app/a.txt', content: 'one\ntwo\n' } }] },
      {
        toolCalls: [
          { name: 'file_edit', arguments: { path: 'app/a.txt', old_string: 'two', new_string: 'three' } },
        ],
      },
      { toolCalls: [{ name: 'bash', arguments: { command: 'ls app' } }] },
      { text: 'Done.' },
    ])
    await call('postMessage', { conversationId: chiefDm }, { content: 'write the file' })
    await host.idle()

    const page = await call<{ messages: Message[] }>('listMessages', { conversationId: chiefDm }, undefined, {
      limit: 50,
    })
    const activity = page.messages.find((m) => m.kind === 'activity')?.payload
    if (activity?.type !== 'activity') throw new Error('expected activity')
    const [write, edit] = activity.steps
    expect(activity.steps.map((s) => s.files)).toEqual([
      [{ path: '/workspace/app/a.txt', status: 'added', additions: 2, deletions: 0 }],
      [{ path: '/workspace/app/a.txt', status: 'modified', additions: 1, deletions: 1 }],
      undefined,
    ])
    const diff = await call<StepDiff>('getToolCallDiff', { toolCallId: edit?.toolCallId as string })
    expect(diff.files).toEqual([
      {
        path: '/workspace/app/a.txt',
        status: 'modified',
        additions: 1,
        deletions: 1,
        patch: '@@ -1,2 +1,2 @@\n one\n-two\n+three',
        truncated: false,
      },
    ])
    expect(
      (await call<StepDiff>('getToolCallDiff', { toolCallId: write?.toolCallId as string })).files[0]?.patch,
    ).toBe('@@ -0,0 +1,2 @@\n+one\n+two')
    await expect(
      call('getToolCallDiff', { toolCallId: activity.steps[2]?.toolCallId as string }),
    ).rejects.toMatchObject({ code: 'not_found' })
  })

  it('returns a screenshot from GUI actions only when asked', async () => {
    await boot([
      { toolCalls: [{ name: 'computer', arguments: { action: 'click', x: 10, y: 20 } }] },
      {
        toolCalls: [{ name: 'computer', arguments: { action: 'type', text: 'hi', screenshot_after: true } }],
      },
      { text: 'Done.' },
    ])
    await call('postMessage', { conversationId: chiefDm }, { content: 'type hi' })
    await host.idle()

    expect(guest.state.screenshots).toBe(1)
    const toolCalls = await call<Array<{ status: string; screenshotSha: string | null }>>(
      'listToolCalls',
      { conversationId: chiefDm },
      undefined,
      { limit: 10 },
    )
    expect(toolCalls.map((t) => [t.status, t.screenshotSha !== null])).toEqual([
      ['ok', false],
      ['ok', true],
    ])
    const llmCalls = await call<Array<{ request: unknown }>>(
      'listLlmCalls',
      { conversationId: chiefDm },
      undefined,
      {
        limit: 10,
      },
    )
    expect(JSON.stringify(llmCalls[1]?.request)).toContain('Done: click (10, 20).')
    expect(JSON.stringify(llmCalls[1]?.request)).not.toMatch(/"sha256"/)
    expect(JSON.stringify(llmCalls[2]?.request)).toMatch(/"sha256":"[0-9a-f]{64}"/)
  })

  it('introduces a new bot after its desktop is ready, surviving connection resets', async () => {
    await boot((tools, i) => {
      if (tools === 0) return { text: 'Hi! I am Bia, I check things on the computer.' }
      return i === 0
        ? {
            toolCalls: [
              {
                name: 'create_bot',
                arguments: { name: 'Bia', label: 'QA', system_prompt: 'You are Bia, a QA specialist.' },
              },
            ],
          }
        : { text: 'Created Bia.' }
    })
    guest.state.provisionDelayMs = 80
    guest.state.connectResets = 2
    await call('postMessage', { conversationId: chiefDm }, { content: 'create a QA bot' })
    await until(() => events.some((e) => e.type === 'bot.created'))
    await host.idle()

    const bia = runtime.store.bots.list().find((b) => b.name === 'Bia')
    if (!bia) throw new Error('Bia was not created')
    expect(guest.state.resetsServed).toBe(2)
    expect(guest.state.provisioned.map((p) => p.slug)).toContain('bia')
    const dm = runtime.store.conversations.findDirect(bia.id)
    const messages = runtime.store.messages.list(dm?.id as string, { limit: 10 }).messages
    expect(messages.map((m) => [m.kind, m.content])).toEqual([
      ['text', 'Hi! I am Bia, I check things on the computer.'],
    ])
    expect(messages[0]?.createdAt).toBeGreaterThanOrEqual(guest.state.provisionedAt.get('bia') as number)
    expect(runtime.store.bots.list().find((b) => b.id === bia.id)?.status).toBe('idle')
  })

  it('creates a specialist bot that gets a desktop and introduces itself', async () => {
    await boot((tools, i) => {
      if (tools === 0) return { text: 'Hi! I am Ana, I handle finance. Where do I start?' }
      return i === 0
        ? {
            toolCalls: [
              {
                name: 'create_bot',
                arguments: {
                  name: 'Ana',
                  label: 'Finance',
                  system_prompt: 'You are Ana, a financial analyst.',
                },
              },
            ],
          }
        : { text: 'Created Ana to handle finance.' }
    })
    await call('postMessage', { conversationId: chiefDm }, { content: 'create a financial analyst' })
    await until(() => events.some((e) => e.type === 'bot.created'))
    await host.idle()

    const bots = runtime.store.bots.list()
    const ana = bots.find((b) => b.name === 'Ana')
    if (!ana) throw new Error('Ana was not created')
    expect(ana).toMatchObject({ label: 'Finance', slug: 'ana', displayNum: 2 })
    await until(() => guest.state.provisioned.some((p) => p.slug === 'ana'))

    const anaDm = runtime.store.conversations.findDirect(ana.id)
    const anaMessages = runtime.store.messages.list(anaDm?.id as string, { limit: 10 }).messages
    expect(anaMessages.map((m) => m.content)).toEqual(['Hi! I am Ana, I handle finance. Where do I start?'])

    const chiefMessages = runtime.store.messages.list(chiefDm, { limit: 10 }).messages
    expect(chiefMessages.some((m) => m.payload?.type === 'system' && m.payload.event === 'bot_created')).toBe(
      true,
    )
    expect(chiefMessages.at(-1)?.content).toBe('Created Ana to handle finance.')

    const display = await call<{ vncPort: number; display: number; control: string }>('getBotDisplay', {
      botId: ana.id,
    })
    expect(display).toMatchObject({
      display: 2,
      vncPort: 47402,
      vncHost: '127.0.0.1',
      width: 1280,
      height: 800,
      control: 'idle',
    })
    expect(await call('controlBot', { botId: ana.id }, { action: 'takeover' })).toMatchObject({
      paused: true,
      control: 'user',
    })
    expect(await call('controlBot', { botId: ana.id }, { action: 'release' })).toMatchObject({
      paused: false,
      control: 'idle',
    })
    expect(events.filter((e) => e.type === 'bot.screen' && e.payload.botId === ana.id)).toEqual([
      { type: 'bot.screen', payload: { botId: ana.id, control: 'user', paused: true, busy: false } },
      { type: 'bot.screen', payload: { botId: ana.id, control: 'idle', paused: false, busy: false } },
    ])
    // Pausing an idle bot shows: its status becomes paused and the display says so.
    expect(await call('controlBot', { botId: ana.id }, { action: 'pause' })).toMatchObject({ paused: true })
    expect(runtime.store.bots.list().find((b) => b.id === ana.id)?.status).toBe('paused')
    expect(await call('getBotDisplay', { botId: ana.id })).toMatchObject({ paused: true, busy: false })
    await call('controlBot', { botId: ana.id }, { action: 'resume' })
    expect(runtime.store.bots.list().find((b) => b.id === ana.id)?.status).toBe('idle')
  })

  it('manages providers and models with secrets outside SQLite', async () => {
    await boot([])
    const provider = await call<{ id: string; baseUrl: string; isDefault: boolean; hasSecret: boolean }>(
      'createProvider',
      {},
      {
        type: 'openai_compatible',
        name: 'OpenRouter',
        preset: 'openrouter',
        apiKey: 'sk-or-secret',
        defaultModel: 'x/y',
      },
    )
    expect(provider).toMatchObject({
      baseUrl: 'https://openrouter.ai/api/v1',
      isDefault: true,
      hasSecret: true,
    })
    expect(await secrets.list(h.workspaceId)).toEqual([`provider.${provider.id}.secret`])
    const raw = runtime.store.db.prepare('SELECT * FROM providers').all()
    expect(JSON.stringify(raw)).not.toContain('sk-or-secret')

    const model = await call<{ modelId: string; priceInputPerMtokUsd: number }>(
      'createProviderModel',
      { providerId: provider.id },
      { modelId: 'x/y', priceInputPerMtokUsd: 1, priceOutputPerMtokUsd: 2 },
    )
    expect(model).toMatchObject({ modelId: 'x/y', priceInputPerMtokUsd: 1 })
    const updated = await call<{ priceOutputPerMtokUsd: number }>(
      'updateProviderModel',
      { providerId: provider.id, modelId: 'x/y' },
      { priceOutputPerMtokUsd: 3 },
    )
    expect(updated.priceOutputPerMtokUsd).toBe(3)

    const cc = await call<{ id: string; authMode: string; isDefault: boolean }>(
      'createProvider',
      {},
      {
        type: 'claude_code',
        name: 'Claude Code',
        isDefault: true,
      },
    )
    expect(cc).toMatchObject({ authMode: 'subscription', isDefault: true })
    const list = await call<Array<{ id: string; isDefault: boolean }>>('listProviders')
    expect(list.filter((p) => p.isDefault).map((p) => p.id)).toEqual([cc.id])

    await call('deleteProvider', { providerId: provider.id })
    expect(await secrets.list(h.workspaceId)).toEqual([])
  })

  it('removes a deleted bot from the VM (now or at the next boot) and then reuses its display', async () => {
    const { vm } = await boot([])
    const { bot: ana } = await call<{ bot: { id: string; displayNum: number } }>(
      'createBot',
      {},
      { name: 'Ana', label: 'Dev' },
    )
    expect(ana.displayNum).toBe(2)
    await until(() => guest.state.provisioned.some((b) => b.slug === 'ana'))
    await call('deleteBot', { botId: ana.id })
    await until(() => guest.state.removed.length === 1)
    expect(guest.state.removed).toEqual([{ slug: 'ana', deleteHome: true }])
    await until(() => runtime.store.bots.pendingRemovals().length === 0)
    const { bot: bia } = await call<{ bot: { id: string; displayNum: number } }>(
      'createBot',
      {},
      { name: 'Bia' },
    )
    expect(bia.displayNum).toBe(2)
    await host.idle()

    // VM stopped: the removal waits for the next boot, and the display stays reserved meanwhile.
    await vm.stop()
    await call('deleteBot', { botId: bia.id })
    await host.idle()
    expect(runtime.store.bots.pendingRemovals().map((b) => b.slug)).toEqual(['bia'])
    const { bot: caio } = await call<{ bot: { displayNum: number } }>('createBot', {}, { name: 'Caio' })
    expect(caio.displayNum).toBe(3)
    await vm.start()
    expect(guest.state.removed.map((r) => r.slug)).toEqual(['ana', 'bia'])
    expect(runtime.store.bots.pendingRemovals()).toEqual([])
    expect(guest.state.provisioned.map((b) => b.slug)).not.toContain('bia')
  })

  it('exposes memory notes, summaries and memory settings; history_search reads the FTS index', async () => {
    await boot([
      { toolCalls: [{ name: 'history_search', arguments: { query: 'production server' } }] },
      { text: 'It is 10.4.2.19.' },
    ])
    runtime.store.messages.create({
      conversationId: chiefDm,
      authorType: 'user',
      content: 'Note: the production server is 10.4.2.19.',
    })
    await call('postMessage', { conversationId: chiefDm }, { content: 'what was the IP?' })
    await host.idle()
    const tools = await call<Array<{ toolName: string; result: { text: string } }>>(
      'listToolCalls',
      { conversationId: chiefDm },
      undefined,
      { limit: 10 },
    )
    expect(tools.map((t) => t.toolName)).toEqual(['history_search'])
    expect(tools[0]?.result.text).toContain('10.4.2.19')

    const note = await call<{ id: string; pinned: boolean }>(
      'createBotMemory',
      { botId: chiefId },
      { content: 'The user prefers short answers.' },
    )
    expect(note.pinned).toBe(true)
    await call('updateBotMemory', { botId: chiefId, memoryId: note.id }, { pinned: false })
    const notes = await call<Array<{ content: string; pinned: boolean }>>('listBotMemories', {
      botId: chiefId,
    })
    expect(notes).toEqual([
      expect.objectContaining({ content: 'The user prefers short answers.', pinned: false }),
    ])
    await call('deleteBotMemory', { botId: chiefId, memoryId: note.id })
    expect(await call('listBotMemories', { botId: chiefId })).toEqual([])

    expect(await call('listConversationSummaries', { conversationId: chiefDm }, undefined, {})).toEqual([])
    expect(await call('getMemorySettings')).toEqual({
      summaryModel: null,
      tailBudgetTokens: 16_000,
      memoryBudgetTokens: 2_000,
      workspaceMemoryBudgetTokens: 1_000,
      summaryBudgetTokens: 3_000,
      retrievedBudgetTokens: 1_500,
    })
    const settings = await call(
      'updateMemorySettings',
      {},
      {
        summaryModel: { providerId: 'prv_x', model: 'cheap' },
        tailBudgetTokens: 8000,
      },
    )
    expect(settings).toMatchObject({
      summaryModel: { providerId: 'prv_x', model: 'cheap' },
      tailBudgetTokens: 8000,
    })
    expect(runtime.store.settings.get('memory.tail_budget_tokens', 0)).toBe(8000)
  })
})

function systemOf(request: CompletionRequest): string {
  return (request.messages[0]?.content ?? []).map((p) => (p.type === 'text' ? p.text : '')).join('')
}

/** Dispatches fake LLM calls by bot ("You are <Name>") and answers triage calls with `triage`. */
function byBot(
  scripts: Record<string, (i: number, request: CompletionRequest) => FakeStep>,
  triage: (request: CompletionRequest) => FakeStep = () => ({ text: '{"respond": []}' }),
) {
  const counts: Record<string, number> = {}
  return (tools: number, _i: number, request: CompletionRequest): FakeStep => {
    const system = systemOf(request)
    if (system === TRIAGE_SYSTEM_PROMPT) return triage(request)
    if (tools === 0) return { text: 'Hi!' }
    const name = /You are ([^,( ]+)/.exec(system)?.[1] ?? '?'
    const n = (counts[name] = (counts[name] ?? -1) + 1)
    return scripts[name]?.(n, request) ?? { text: `${name} ok` }
  }
}

describe('groups and bot-to-bot messaging', () => {
  const messagesOf = (conversationId: string) =>
    runtime.store.messages.list(conversationId, { limit: 100 }).messages
  const systemEvents = (conversationId: string) =>
    messagesOf(conversationId).flatMap((m) =>
      m.payload?.type === 'system' ? [[m.payload.event, m.payload.params]] : [],
    )

  async function createBots(...names: string[]) {
    const bots = []
    for (const name of names) {
      bots.push(
        (await call<{ bot: { id: string; name: string } }>('createBot', {}, { name, label: name })).bot,
      )
    }
    await host.idle()
    return bots
  }

  it('edits members and behavior of a group through the API, with system lines', async () => {
    await boot(byBot({}))
    const [ana, bia] = await createBots('Ana', 'Bia')
    const group = await call<ConversationSummary>(
      'createConversation',
      {},
      { type: 'group', title: 'Squad', botIds: [ana?.id] },
    )
    const added = await call<ConversationSummary>(
      'addGroupMember',
      { conversationId: group.id },
      { botId: bia?.id },
    )
    expect(added.memberBotIds).toEqual([ana?.id, bia?.id])
    const updated = await call<ConversationSummary>(
      'updateGroupSettings',
      { conversationId: group.id },
      { respondWithoutMention: false, maxConsecutiveBotMessages: 3 },
    )
    expect(updated.settings).toEqual({ respondWithoutMention: false, maxConsecutiveBotMessages: 3 })
    const removed = await call<ConversationSummary>('removeGroupMember', {
      conversationId: group.id,
      botId: bia?.id as string,
    })
    expect(removed.memberBotIds).toEqual([ana?.id])
    await expect(
      call('removeGroupMember', { conversationId: group.id, botId: ana?.id as string }),
    ).rejects.toMatchObject({ code: 'conflict' })
    expect(systemEvents(group.id)).toEqual([
      ['member_added', expect.objectContaining({ actor: 'user', botName: 'Bia' })],
      ['member_removed', expect.objectContaining({ actor: 'user', botName: 'Bia' })],
    ])
    // Re-adding a bot that left reactivates its membership.
    await call('addGroupMember', { conversationId: group.id }, { botId: bia?.id })
    expect(runtime.store.conversations.get(group.id).memberBotIds).toEqual([ana?.id, bia?.id])
    await expect(
      call('updateGroupSettings', { conversationId: chiefDm }, { respondWithoutMention: false }),
    ).rejects.toMatchObject({ code: 'validation_failed' })
  })

  it('asks the user before a bot removes a member; rejecting keeps it, approving removes it', async () => {
    await boot(
      byBot({
        Maestro: (i) =>
          i % 2 === 0
            ? {
                toolCalls: [
                  {
                    name: 'remove_member',
                    arguments: { group: 'squad', bot: 'Bia', reason: 'Bia is no longer part of it.' },
                  },
                ],
              }
            : { text: 'I asked for your confirmation.' },
      }),
    )
    const [ana, bia] = await createBots('Ana', 'Bia')
    const group = await call<ConversationSummary>(
      'createConversation',
      {},
      { type: 'group', title: 'Squad', botIds: [ana?.id, bia?.id] },
    )
    const cards = () => messagesOf(chiefDm).filter((m) => m.payload?.type === 'confirmation')

    await call('postMessage', { conversationId: chiefDm }, { content: 'remove Bia from Squad' })
    await host.idle()
    expect(cards()).toHaveLength(1)
    const first = cards()[0]?.payload
    if (first?.type !== 'confirmation') throw new Error('expected a confirmation card')
    expect(first).toMatchObject({
      action: 'remove_member',
      status: 'pending',
      description: 'Bia is no longer part of it.',
      params: { botName: 'Bia', groupName: 'Squad' },
    })
    const rejected = await call<Message>(
      'resolveConfirmation',
      { confirmationId: first.confirmationId },
      { approved: false },
    )
    expect(rejected.payload).toMatchObject({ status: 'rejected' })
    expect(runtime.store.conversations.get(group.id).memberBotIds).toContain(bia?.id)
    // Resolving twice keeps the first answer.
    await call('resolveConfirmation', { confirmationId: first.confirmationId }, { approved: true })
    expect(runtime.store.conversations.get(group.id).memberBotIds).toContain(bia?.id)

    await call('postMessage', { conversationId: chiefDm }, { content: 'yes, remove her' })
    await host.idle()
    const second = cards()[1]?.payload
    if (second?.type !== 'confirmation') throw new Error('expected a second card')
    const approved = await call<Message>(
      'resolveConfirmation',
      { confirmationId: second.confirmationId },
      { approved: true },
    )
    expect(approved.payload).toMatchObject({ status: 'approved' })
    expect(runtime.store.conversations.get(group.id).memberBotIds).toEqual([ana?.id])
    expect(systemEvents(group.id)).toEqual([
      ['member_removed', expect.objectContaining({ actor: 'bot', actorName: 'Maestro', botName: 'Bia' })],
    ])
    expect(events.some((e) => e.type === 'message.updated' && e.payload.message.id === approved.id)).toBe(
      true,
    )

    // Without confirmation the removal is immediate.
    await call('addGroupMember', { conversationId: group.id }, { botId: bia?.id })
    await call('updateGroupSettings', { conversationId: group.id }, { confirmRemovals: false })
    await call('postMessage', { conversationId: chiefDm }, { content: 'again' })
    await host.idle()
    expect(cards()).toHaveLength(2)
    expect(runtime.store.conversations.get(group.id).memberBotIds).toEqual([ana?.id])
  })

  it('refuses member changes by bots when the group does not allow them', async () => {
    await boot(
      byBot({
        Ana: (i) =>
          i === 0
            ? { toolCalls: [{ name: 'add_member', arguments: { group: 'current', bot: 'Bia' } }] }
            : { text: 'I cannot.' },
      }),
    )
    const [ana, bia] = await createBots('Ana', 'Bia')
    const group = await call<ConversationSummary>(
      'createConversation',
      {},
      { type: 'group', title: 'Squad', botIds: [ana?.id], settings: { botsCanManageMembers: false } },
    )
    await call('postMessage', { conversationId: group.id }, { content: 'add Bia' })
    await host.idle()
    const tools = await call<Array<{ toolName: string; result: { text: string } }>>(
      'listToolCalls',
      { conversationId: group.id },
      undefined,
      { limit: 10 },
    )
    expect(tools[0]?.result.text).toContain('does not let bots change the members')
    expect(runtime.store.conversations.get(group.id).memberBotIds).not.toContain(bia?.id)
  })

  it('lets group members manage members by the group setting, not by team management', async () => {
    await boot(
      byBot({
        Ana: (i) =>
          i === 0
            ? {
                toolCalls: [
                  { name: 'create_bot', arguments: { name: 'Leo', label: 'Leo', system_prompt: 'Leo.' } },
                  { name: 'add_member', arguments: { group: 'current', bot: 'Bia' } },
                ],
              }
            : { text: 'Done.' },
      }),
    )
    const [ana, bia] = await createBots('Ana', 'Bia')
    const group = await call<ConversationSummary>(
      'createConversation',
      {},
      { type: 'group', title: 'Squad', botIds: [ana?.id], settings: { botsCanManageMembers: true } },
    )
    await call('postMessage', { conversationId: group.id }, { content: '@Ana add Bia' })
    await host.idle()
    const tools = await call<Array<{ toolName: string; result: { text: string } }>>(
      'listToolCalls',
      { conversationId: group.id },
      undefined,
      { limit: 10 },
    )
    const result = (name: string) => tools.find((t) => t.toolName === name)?.result.text
    expect(result('create_bot')).toContain('turned off for you')
    expect(result('add_member')).toBe('Added Bia to "Squad".')
    expect(runtime.store.conversations.get(group.id).memberBotIds).toContain(bia?.id)
    expect(runtime.store.bots.list().map((b) => b.name)).not.toContain('Leo')
  })

  it('lets any bot with team management active create bots', async () => {
    await boot(
      byBot({
        Ana: (i) =>
          i === 0
            ? {
                toolCalls: [
                  {
                    name: 'create_bot',
                    arguments: { name: 'Leo', label: 'Dev', system_prompt: 'You write code.' },
                  },
                ],
              }
            : { text: 'Created Leo.' },
      }),
    )
    const [ana] = await createBots('Ana')
    await call(
      'updateBotSkill',
      { botId: ana?.id ?? '', skillId: 'builtin:team-management' },
      { enabled: true },
    )
    const anaDm = runtime.store.conversations.findDirect(ana?.id ?? '')?.id ?? ''
    await call('postMessage', { conversationId: anaDm }, { content: 'create a dev' })
    await host.idle()
    expect(runtime.store.bots.list().map((b) => b.name)).toEqual(['Maestro', 'Ana', 'Leo'])
    expect(runtime.store.bots.first()?.id).toBe(chiefId)
  })

  it('never deletes the bot asking for it, nor the last bot', async () => {
    await boot(
      byBot({
        Maestro: (i) =>
          i === 0
            ? { toolCalls: [{ name: 'delete_bot', arguments: { bot: 'Maestro', reason: 'Bye.' } }] }
            : { text: 'I cannot.' },
      }),
    )
    await expect(call('deleteBot', { botId: chiefId })).rejects.toMatchObject({
      code: 'conflict',
      details: { reason: 'last_bot' },
    })
    await createBots('Ana')
    await call('postMessage', { conversationId: chiefDm }, { content: 'delete yourself' })
    await host.idle()
    const tools = await call<Array<{ toolName: string; result: { text: string } }>>(
      'listToolCalls',
      { conversationId: chiefDm },
      undefined,
      { limit: 10 },
    )
    expect(tools.find((t) => t.toolName === 'delete_bot')?.result.text).toContain('cannot delete yourself')
    expect(runtime.store.bots.list().map((b) => b.name)).toEqual(['Maestro', 'Ana'])
    await call('deleteBot', { botId: chiefId })
    expect(runtime.store.bots.first()?.name).toBe('Ana')
  })

  it('deletes a bot only after the user confirms', async () => {
    await boot(
      byBot({
        Maestro: (i) =>
          i === 0
            ? { toolCalls: [{ name: 'delete_bot', arguments: { bot: 'Ana', reason: 'No longer used.' } }] }
            : { text: 'Waiting for your confirmation.' },
      }),
    )
    const [ana] = await createBots('Ana')
    await call('postMessage', { conversationId: chiefDm }, { content: 'delete Ana' })
    await host.idle()
    expect(runtime.store.bots.list().map((b) => b.name)).toContain('Ana')
    const card = messagesOf(chiefDm).find((m) => m.payload?.type === 'confirmation')?.payload
    if (card?.type !== 'confirmation') throw new Error('expected a card')
    expect(card).toMatchObject({ action: 'delete_bot', params: { botName: 'Ana' } })
    await call('resolveConfirmation', { confirmationId: card.confirmationId }, { approved: true })
    expect(runtime.store.bots.list().map((b) => b.name)).not.toContain('Ana')
    expect(events.some((e) => e.type === 'bot.deleted' && e.payload.botId === ana?.id)).toBe(true)
    expect(systemEvents(chiefDm).at(-1)).toEqual(['bot_deleted', expect.objectContaining({ botName: 'Ana' })])
  })

  it('pauses a long exchange between bots on a card and sends the held message once the user lets it go on', async () => {
    const lastText = (request: CompletionRequest) =>
      request.messages
        .at(-1)
        ?.content.map((p) => (p.type === 'text' ? p.text : ''))
        .join('') ?? ''
    await boot(
      byBot({
        Maestro: (_i, request) =>
          /Sent to|Not sent yet/.test(lastText(request))
            ? { text: 'Waiting on Iris.' }
            : {
                toolCalls: [{ name: 'message_bot', arguments: { bot: 'Iris', message: 'One more check?' } }],
              },
        Iris: () => ({ text: 'Checked.' }),
      }),
    )
    await createBots('Iris')
    await call('postMessage', { conversationId: chiefDm }, { content: 'work it out with Iris' })
    await host.idle()
    const sent = () => messagesOf(chiefDm).filter((m) => m.payload?.type === 'bot_message_sent').length
    expect(sent()).toBe(3)
    const card = messagesOf(chiefDm).find((m) => m.payload?.type === 'confirmation')?.payload
    if (card?.type !== 'confirmation') throw new Error('expected a card')
    expect(card).toMatchObject({
      action: 'continue_bot_exchange',
      description: 'One more check?',
      params: { botName: 'Iris' },
    })
    await call('resolveConfirmation', { confirmationId: card.confirmationId }, { approved: true })
    await host.idle()
    expect(sent()).toBe(6)
    const cards = messagesOf(chiefDm).filter((m) => m.payload?.type === 'confirmation')
    expect(cards.map((m) => (m.payload?.type === 'confirmation' ? m.payload.status : null))).toEqual([
      'approved',
      'pending',
    ])
  })

  it('creates a group, routes by triage and runs ask_bot through an internal conversation', async () => {
    await boot(
      byBot(
        {
          Maestro: (i, request) => {
            if (i === 0)
              return {
                toolCalls: [
                  { name: 'create_group', arguments: { name: 'Research', members: ['Iris', 'Lia'] } },
                ],
              }
            if (i === 1) return { text: 'Group created.' }
            if (i === 2)
              return {
                toolCalls: [{ name: 'ask_bot', arguments: { bot: 'Iris', message: 'What is the CPI?' } }],
              }
            const last = request.messages
              .at(-1)
              ?.content.map((p) => (p.type === 'text' ? p.text : ''))
              .join('')
            return { text: `Answer: ${last?.includes('0.2%') ? '0.2%' : '?'}` }
          },
          Iris: () => ({ text: 'CPI 0.2%.' }),
        },
        (request) => ({
          text: JSON.stringify({
            respond: systemOf(request) && JSON.stringify(request).includes('inflation') ? ['iris'] : [],
          }),
        }),
      ),
    )
    const [iris, lia] = await createBots('Iris', 'Lia')
    await call('postMessage', { conversationId: chiefDm }, { content: 'create a research group' })
    await host.idle()
    const group = runtime.store.conversations.list().find((c) => c.type === 'group')
    if (!group) throw new Error('group not created')
    expect(group).toMatchObject({ title: 'Research', memberBotIds: [iris?.id, lia?.id] })
    expect(systemEvents(group.id)).toEqual([
      ['group_created', expect.objectContaining({ actorName: 'Maestro', groupName: 'Research' })],
    ])

    await call('postMessage', { conversationId: group.id }, { content: 'what was the inflation in August?' })
    await host.idle()
    expect(
      messagesOf(group.id)
        .filter((m) => m.kind === 'text')
        .map((m) => m.authorBotId ?? 'user'),
    ).toEqual(['user', iris?.id])
    const calls = await call<Array<{ purpose: string; botId: string | null }>>(
      'listLlmCalls',
      { conversationId: group.id },
      undefined,
      { limit: 20 },
    )
    expect(calls.filter((c) => c.purpose === 'triage').map((c) => c.botId)).toEqual([null, null])

    await call('postMessage', { conversationId: chiefDm }, { content: 'ask Iris for the CPI' })
    await host.idle()
    const card = messagesOf(chiefDm).find((m) => m.payload?.type === 'bot_message_sent')?.payload
    if (card?.type !== 'bot_message_sent') throw new Error('expected the card')
    expect(card).toMatchObject({ targetBotId: iris?.id, awaitReply: true, status: 'replied' })
    const internal = await call<ConversationSummary>('getConversation', {
      conversationId: card.internalConversationId as string,
    })
    expect(internal.type).toBe('internal')
    expect(messagesOf(internal.id).map((m) => [m.authorBotId, m.content])).toEqual([
      [chiefId, 'What is the CPI?'],
      [iris?.id, 'CPI 0.2%.'],
    ])
    expect(
      events.some((e) => e.type === 'conversation.created' && e.payload.conversation.id === internal.id),
    ).toBe(true)
    expect(messagesOf(chiefDm).at(-1)?.content).toBe('Answer: 0.2%')
  })
})
