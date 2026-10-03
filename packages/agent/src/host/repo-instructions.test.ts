import { describe, expect, it } from 'vitest'

import type { RepoInstructionFile } from '../environment'
import { FakeProvider, type FakeStep } from '../llm/fake'
import type { ChatMessage, ToolCall } from '../llm/messages'
import type { CompletionRequest } from '../llm/provider'
import { MAX_TOOL_OUTPUT_CHARS } from '../memory/chat-messages'
import {
  loadedInstructionFiles,
  REPO_INSTRUCTIONS_TOTAL_MAX,
  repoInstructionTexts,
} from '../prompts/repo-instructions'
import { makeBot, TestEnv } from '../test-support/env'
import { fakeRepoInstructions } from '../test-support/repo-instructions'
import { DefaultAgentHost } from './agent-host'
import { touchedFolders } from './turn/repo-instructions'

const WT = '/workspace/worktrees/app/ana'

const textOf = (message: ChatMessage | undefined) =>
  (message?.content ?? []).map((p) => (p.type === 'text' ? p.text : '')).join('\n')

/** Instruction files in each tool result of the last request, by call. */
const loadedByTool = (request: CompletionRequest | undefined) =>
  (request?.messages ?? [])
    .filter((m) => m.role === 'tool')
    .map((m) => loadedInstructionFiles(textOf(m)).map((f) => f.path))

const loadedInSystem = (request: CompletionRequest | undefined) =>
  loadedInstructionFiles(textOf(request?.messages[0])).map((f) => f.path)

async function setup(
  script: FakeStep[] | ((request: CompletionRequest) => FakeStep),
  repo: { files: Record<string, string>; repos?: string[] },
  session?: { cwd: string },
) {
  const provider = new FakeProvider({ script })
  const env = new TestEnv(provider)
  const resolver = fakeRepoInstructions(repo.repos ?? [WT], repo.files)
  env.repoInstructions = resolver
  env.toolHandler = async (ctx, call) => {
    if (call.name === 'repo_checkout') {
      const root = await resolver(ctx.bot, [WT])
      return {
        content: [
          { type: 'text', text: `Worktree ready: ${WT}` },
          ...repoInstructionTexts(root).map((text) => ({ type: 'text' as const, text })),
        ],
      }
    }
    return { content: [{ type: 'text', text: `ran ${call.name}` }] }
  }
  const bot = makeBot()
  const conversation = env.addBot(bot)
  if (session) {
    env.sessions.set(conversation.id, 'wses_1')
    const sessions = env.workSessions as unknown as { views: Map<string, unknown> }
    sessions.views.set('wses_1', {
      id: 'wses_1',
      botId: bot.id,
      conversationId: conversation.id,
      title: 'Work',
      goal: '',
      cwd: session.cwd,
      projectId: null,
      planId: null,
      repoName: 'app',
      branch: 'bot/ana/work',
      brief: '# Session brief: Work',
    })
  }
  const host = new DefaultAgentHost({ deltaFlushMs: 1, compaction: false })
  await host.start(env)
  return { env, bot, conversation, host, provider, resolver }
}

const read = (path: string): FakeStep => ({ toolCalls: [{ name: 'file_read', arguments: { path } }] })

describe('repository instructions (native lanes)', () => {
  it('chat: repo_checkout brings the root file, a file of a subfolder brings that folder’s, each once', async () => {
    const t = await setup(
      [
        { toolCalls: [{ name: 'repo_checkout', arguments: { repo: 'app' } }] },
        read(`${WT}/apps/daemon/x.ts`),
        read(`${WT}/apps/daemon/y.ts`),
        read(`${WT}/README.md`),
        { text: 'done' },
      ],
      {
        files: {
          [`${WT}/CLAUDE.md`]: '# Root rules',
          [`${WT}/apps/daemon/CLAUDE.md`]: '# Daemon rules',
          [`${WT}/apps/daemon/x.ts`]: '',
        },
      },
    )
    t.host.onMessageCreated(t.env.userMessage(t.conversation.id, 'fix the daemon'))
    await t.host.idle(t.bot.id)
    const last = t.provider.requests.at(-1)
    expect(loadedByTool(last)).toEqual([[`${WT}/CLAUDE.md`], [`${WT}/apps/daemon/CLAUDE.md`], [], []])
    const daemon = last?.messages.filter((m) => m.role === 'tool')[1]
    expect(textOf(daemon)).toContain('# Daemon rules')
    // One resolution per folder in the turn.
    expect(t.resolver.calls.slice(1)).toEqual([[`${WT}/apps/daemon`], [WT]])
  })

  it('chat: the next turn starts without them and loads them again when it works there', async () => {
    const t = await setup([read(`${WT}/a.ts`), { text: 'one' }, read(`${WT}/b.ts`), { text: 'two' }], {
      files: { [`${WT}/AGENTS.md`]: '# Agents rules' },
    })
    t.host.onMessageCreated(t.env.userMessage(t.conversation.id, 'first'))
    await t.host.idle(t.bot.id)
    t.host.onMessageCreated(t.env.userMessage(t.conversation.id, 'second'))
    await t.host.idle(t.bot.id)
    const [, firstEnd, , secondEnd] = t.provider.requests
    expect(loadedByTool(firstEnd)).toEqual([[`${WT}/AGENTS.md`]])
    expect(loadedByTool(secondEnd)).toEqual([[`${WT}/AGENTS.md`]])
  })

  it.each([
    ['only CLAUDE.md', { [`${WT}/CLAUDE.md`]: 'c' }, [`${WT}/CLAUDE.md`]],
    ['only AGENTS.md', { [`${WT}/AGENTS.md`]: 'a' }, [`${WT}/AGENTS.md`]],
    [
      'both, different',
      { [`${WT}/CLAUDE.md`]: 'c', [`${WT}/AGENTS.md`]: 'a' },
      [`${WT}/CLAUDE.md`, `${WT}/AGENTS.md`],
    ],
    ['both, same text', { [`${WT}/CLAUDE.md`]: 'same\n', [`${WT}/AGENTS.md`]: ' same' }, [`${WT}/CLAUDE.md`]],
    [
      'AGENTS.md linked to CLAUDE.md',
      { [`${WT}/CLAUDE.md`]: 'c', [`${WT}/AGENTS.md`]: `->${WT}/CLAUDE.md` },
      [`${WT}/CLAUDE.md`],
    ],
  ])('session with a repository loads the root files in the system: %s', async (_name, files, expected) => {
    const t = await setup([{ text: 'working' }], { files }, { cwd: WT })
    t.host.enqueueTurn({
      botId: t.bot.id,
      conversationId: t.conversation.id,
      trigger: 'session_start',
      note: 'go',
    })
    await t.host.idle(t.bot.id)
    const request = t.provider.requests[0]
    expect(loadedInSystem(request)).toEqual(expected)
    // Right after the brief, in the cached fixed part.
    const fixed = request?.messages[0]?.content[1]
    expect(
      fixed?.type === 'text' && fixed.text.startsWith('# Session brief: Work\n\n<repository_instructions'),
    ).toBe(true)
  })

  it('session: a subfolder file comes with the tool result, the root one is not repeated', async () => {
    const t = await setup(
      [read('apps/daemon/x.ts'), read(`${WT}/CLAUDE.md`), { text: 'done' }],
      {
        files: {
          [`${WT}/CLAUDE.md`]: '# Root rules',
          [`${WT}/apps/daemon/CLAUDE.md`]: '# Daemon rules',
        },
      },
      { cwd: WT },
    )
    t.host.enqueueTurn({
      botId: t.bot.id,
      conversationId: t.conversation.id,
      trigger: 'session_start',
      note: 'go',
    })
    await t.host.idle(t.bot.id)
    const last = t.provider.requests.at(-1)
    expect(loadedInSystem(last)).toEqual([`${WT}/CLAUDE.md`])
    expect(loadedByTool(last)).toEqual([[`${WT}/apps/daemon/CLAUDE.md`], []])
  })

  it('session helpers get the root files in their system', async () => {
    const t = await setup(
      (request) => {
        const helper = textOf(request.messages[0]).includes('# Helper task')
        const last = request.messages.at(-1)
        if (helper) return { text: 'report' }
        if (last?.role === 'user') return { toolCalls: [{ name: 'subagent', arguments: { task: 'map it' } }] }
        return { text: 'done' }
      },
      { files: { [`${WT}/AGENTS.md`]: '# Agents rules' } },
      { cwd: WT },
    )
    t.host.enqueueTurn({
      botId: t.bot.id,
      conversationId: t.conversation.id,
      trigger: 'session_start',
      note: 'go',
    })
    await t.host.idle()
    const helper = t.provider.requests.find((r) => textOf(r.messages[0]).includes('# Helper task'))
    expect(loadedInSystem(helper)).toEqual([`${WT}/AGENTS.md`])
  })

  it('keeps instruction files whole past the tool output cut and points to the ones over the total', async () => {
    const big = `${'rule line\n'.repeat(3000)}`
    const t = await setup([read(`${WT}/apps/daemon/x.ts`), { text: 'done' }], {
      files: {
        [`${WT}/CLAUDE.md`]: big,
        [`${WT}/apps/CLAUDE.md`]: big,
        [`${WT}/apps/daemon/CLAUDE.md`]: big,
      },
    })
    t.host.onMessageCreated(t.env.userMessage(t.conversation.id, 'go'))
    await t.host.idle(t.bot.id)
    const tool = t.provider.requests.at(-1)?.messages.find((m) => m.role === 'tool')
    const parts = (tool?.content ?? []).map((p) => (p.type === 'text' ? p.text : ''))
    expect(parts).toHaveLength(4)
    expect(parts[1]?.length).toBeGreaterThan(MAX_TOOL_OUTPUT_CHARS)
    expect(parts[1]).not.toContain('characters of output omitted')
    expect(parts.slice(1).reduce((n, p) => n + p.length, 0)).toBeLessThan(REPO_INSTRUCTIONS_TOTAL_MAX + 2000)
    expect(parts[3]).toContain('omitted="true"')
    expect(parts[3]).toContain(`read that file before working in that folder`)
  })
})

describe('repoInstructionTexts', () => {
  it('says when a file was cut and how to read the rest', () => {
    const file: RepoInstructionFile = {
      path: '/workspace/app/CLAUDE.md',
      bytes: 120 * 1024,
      truncated: true,
      content: 'first\n',
      sameAs: [],
    }
    const [text] = repoInstructionTexts([file])
    expect(text).toContain('truncated="true"')
    expect(text).toContain(
      '[cut: the file has 120 KB, the first 1 KB are above; read the rest of /workspace/app/CLAUDE.md',
    )
    expect(loadedInstructionFiles(text ?? '')).toEqual([
      { path: '/workspace/app/CLAUDE.md', bytes: 120 * 1024, truncated: true },
    ])
  })
})

describe('touchedFolders', () => {
  const call = (name: string, args: Record<string, unknown>): ToolCall => ({ id: 'c', name, arguments: args })
  it('maps each file and shell tool to the folders it worked in', () => {
    expect(touchedFolders(call('file_edit', { path: 'src/a.ts' }), WT)).toEqual([`${WT}/src`])
    expect(touchedFolders(call('grep', { pattern: 'x' }), WT)).toEqual([WT])
    expect(touchedFolders(call('bash', { command: 'ls', cwd: '/workspace/other' }), WT)).toEqual([
      '/workspace/other',
    ])
    const patch = '--- a/apps/x.ts\n+++ b/apps/x.ts\n@@\n*** Add File: docs/new.md\n--- /dev/null\n'
    expect(touchedFolders(call('apply_patch', { patch }), WT)).toEqual([WT, `${WT}/apps`, `${WT}/docs`])
    expect(touchedFolders(call('file_read', { path: '/etc/passwd' }), WT)).toEqual([])
    expect(touchedFolders(call('web_fetch', { url: 'x' }), WT)).toEqual([])
  })
})
