import type { Bot, Message, TaskPayload } from '@milibot/shared'
import type { ExecResult } from '@milibot/shared'
import { beforeEach, describe, expect, it } from 'vitest'

import { TaskCardService } from '../../../src/runtime/tasks/service'
import { WorkspaceStore } from '../../../src/runtime/workspace-store'
import { openWorkspaceDb } from '../../../src/workspace-db/open'

let store: WorkspaceStore
let service: TaskCardService
let nina: Bot
let dm: string
let execs: Array<{ cmd: string; env: Record<string, string> }>
let prState: Record<string, unknown> | null
let pullRequests: Array<{ conversationId: string; url: string | null; status: string }>

const exec = (stdout: string, code = 0): ExecResult => ({
  code,
  signal: null,
  stdout,
  stderr: '',
  truncated: { stdout: false, stderr: false },
  timedOut: false,
  durationMs: 1,
})

beforeEach(() => {
  const db = openWorkspaceDb(':memory:')
  store = new WorkspaceStore(db, () => Date.now())
  nina = store.bots.create({ name: 'Nina', label: 'Dev', systemPrompt: '' })
  dm = store.conversations.create({ type: 'direct', botIds: [nina.id] }).id
  execs = []
  prState = null
  pullRequests = []
  service = new TaskCardService({
    messages: store.messages,
    getBot: (id) => (id === nina.id ? nina : null),
    directConversationId: () => dm,
    appendMessage: (message) => store.messages.create(message),
    updateMessage: (id, patch) => {
      store.messages.update(id, patch)
      return store.messages.get(id)
    },
    exec: async (_bot, cmd, env) => {
      execs.push({ cmd, env })
      return prState ? exec(JSON.stringify(prState)) : exec('', 1)
    },
    onPullRequest: (conversationId, payload) =>
      pullRequests.push({ conversationId, url: payload.url, status: payload.status }),
  })
})

const cards = (): Array<Message & { payload: TaskPayload }> =>
  store.messages.list(dm, { limit: 50 }).messages.filter((m) => m.payload?.type === 'task') as Array<
    Message & { payload: TaskPayload }
  >

function shell(id: string, command: string, output: string, status: 'ok' | 'error' = 'ok', tool = 'Bash') {
  service.onToolStarted({
    id,
    llmCallId: null,
    botId: nina.id,
    conversationId: dm,
    turnId: null,
    toolName: tool,
    arguments: { command },
    startedAt: 0,
  })
  service.onToolFinished(id, {
    status,
    result: { text: output },
    error: null,
    screenshotSha: null,
    finishedAt: 1,
  })
}

describe('pull requests from shell commands', () => {
  it('creates a card from gh pr create and moves it to done on merge', async () => {
    prState = {
      number: 42,
      title: 'Fix login',
      url: 'https://github.com/acme/app/pull/42',
      state: 'OPEN',
      isDraft: false,
      headRefName: 'bot/nina/login',
    }
    shell(
      't1',
      'git push && gh pr create --title "Fix login" --fill',
      'https://github.com/acme/app/pull/42\n',
    )
    await service.idle()
    expect(execs[0]?.env).toEqual({ PR_TARGET: 'https://github.com/acme/app/pull/42' })
    expect(cards().map((c) => c.payload)).toEqual([
      expect.objectContaining({ status: 'review', prNumber: 42, branch: 'bot/nina/login', repo: 'acme/app' }),
    ])

    prState = { ...prState, state: 'MERGED' }
    shell('t2', 'gh pr merge 42 --squash', '✓ Squashed and merged pull request acme/app#42 (Fix login)')
    await service.idle()
    expect(cards().map((c) => [c.payload.status, c.payload.title])).toEqual([['done', 'Fix login']])
  })

  it('falls back to the command when gh pr view is not available', async () => {
    shell(
      't1',
      'gh pr create --draft --title "WIP report"',
      'https://github.com/acme/app/pull/5',
      'ok',
      'bash',
    )
    await service.idle()
    expect(cards()[0]?.payload).toMatchObject({ status: 'open', title: 'WIP report', prNumber: 5 })
    shell('t2', 'gh pr merge 5', 'Merged pull request #5')
    await service.idle()
    expect(cards().map((c) => c.payload.status)).toEqual(['done'])
  })

  it('ignores unrelated commands, failures and cancelled calls', async () => {
    shell('a', 'ls -la', 'https://github.com/acme/app/pull/1')
    shell('b', 'gh pr create --fill', 'GraphQL: something failed', 'error')
    shell('c', 'gh pr list', 'https://github.com/acme/app/pull/1')
    service.onToolStarted({
      id: 'd',
      llmCallId: null,
      botId: nina.id,
      conversationId: dm,
      turnId: null,
      toolName: 'Bash',
      arguments: { command: 'gh pr create --fill' },
      startedAt: 0,
    })
    service.onToolFinished('d', {
      status: 'cancelled',
      result: null,
      error: null,
      screenshotSha: null,
      finishedAt: 1,
    })
    await service.idle()
    expect(cards()).toHaveLength(0)
  })

  it('shows the pull request of a branch released with repo_release', async () => {
    prState = {
      number: 9,
      title: 'New screen',
      url: 'https://github.com/acme/app/pull/9',
      state: 'OPEN',
      isDraft: true,
      headRefName: 'bot/nina/screen',
    }
    service.onToolStarted({
      id: 'r',
      llmCallId: null,
      botId: nina.id,
      conversationId: dm,
      turnId: null,
      toolName: 'repo_release',
      arguments: { repo: 'app' },
      startedAt: 0,
    })
    service.onToolFinished('r', {
      status: 'ok',
      result: {
        text: 'Removed /workspace/worktrees/app/nina (branch bot/nina/screen is kept in the repository).',
      },
      error: null,
      screenshotSha: null,
      finishedAt: 1,
    })
    await service.idle()
    expect(execs[0]?.env).toEqual({ PR_TARGET: 'bot/nina/screen', PR_CWD: '/workspace/repos/app' })
    expect(cards()[0]?.payload).toMatchObject({ status: 'open', title: 'New screen', prNumber: 9 })
  })
})

describe('pull request statuses read on GitHub', () => {
  const card = (url: string | null, status: TaskPayload['status'], title = 'Fix login') =>
    service.report(nina, dm, null, {
      title,
      status,
      url,
      repo: null,
      prNumber: null,
      branch: null,
      botId: nina.id,
    })

  it('tracks the pull request cards not merged yet and updates them in place', () => {
    card('https://github.com/acme/app/pull/18', 'review')
    card('https://github.com/acme/app/pull/19', 'done', 'Fix logout')
    card('https://github.com/acme/app/pull/20', 'failed', 'Fix signup')
    card('https://ci.example.com/deploy/1', 'open', 'Deploy')
    card(null, 'open', 'Write docs')
    expect(service.trackedPullRequests()).toEqual([
      'https://github.com/acme/app/pull/20',
      'https://github.com/acme/app/pull/18',
    ])

    service.applyPullRequestStatuses(
      new Map([
        ['https://github.com/acme/app/pull/18', 'done'],
        ['https://github.com/acme/app/pull/20', 'review'],
        ['https://github.com/acme/app/pull/19', 'failed'],
      ]),
    )
    const byTitle = Object.fromEntries(cards().map((m) => [m.payload.title, m]))
    expect(byTitle['Fix login']?.payload.status).toBe('done')
    expect(byTitle['Fix login']?.content).toBe('Fix login — done (https://github.com/acme/app/pull/18)')
    expect(byTitle['Fix signup']?.payload.status).toBe('review')
    expect(byTitle['Fix logout']?.payload.status).toBe('done')
    expect(byTitle['Deploy']?.payload.status).toBe('open')
    expect(service.trackedPullRequests()).toEqual(['https://github.com/acme/app/pull/20'])
  })
})
