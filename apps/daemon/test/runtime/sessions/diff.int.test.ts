import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import type { DefaultAgentHost } from '@milibot/agent'
import type { ChatMessage, CompletionRequest } from '@milibot/agent/llm'
import type { FakeStep } from '@milibot/agent/testing'
import type {
  Message,
  Plan,
  SessionChanges,
  SessionFileDiff,
  SessionFileImages,
  WorkSession,
  WorkSessionPayload,
  WorkspaceEvent,
} from '@milibot/shared'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { WorkspaceRuntime } from '../../../src/runtime/runtime'
import { MAX_PATCH_BYTES } from '../../../src/runtime/sessions/diff'
import { fakeGuest } from '../../support/fake-guest'
import { bootRuntime, type RuntimeHarness, stopRuntimes } from '../../support/runtime-harness'
import { useTempDir } from '../../support/temp'
import { until } from '../../support/wait'

let h: RuntimeHarness
/** Stands for the VM's /workspace: the guest's commands run here, with real git. */
let root: string
let runtime: WorkspaceRuntime
let host: DefaultAgentHost
let events: WorkspaceEvent[]
let chiefDm: string

const dir = useTempDir('session-diff')
afterEach(stopRuntimes)

beforeEach(() => {
  root = join(dir(), 'workspace')
  mkdirSync(root, { recursive: true })
})

const toLocal = (path: string) => (path.startsWith('/workspace') ? join(root, path.slice(10)) : path)

const REPO_SETUP = String.raw`
set -e
mkdir -p "$WT_PATH"
cd "$WT_PATH"
git init -q -b main
printf 'one\ntwo\nthree\n' > a.txt
seq 1 5 > b.txt
seq 1 40 > c.txt
printf '\000\001\002\003' > img.bin
mkdir -p art
printf '\211PNG\r\n\032\n\000old' > art/logo.png
printf '\211PNG\r\n\032\n\000gone' > gone.png
printf 'ignored.log\n' > .gitignore
git add -A
git commit -qm init
`

function run(cmd: string, cwd: string, env: Record<string, string>) {
  const result = spawnSync('bash', ['-c', cmd], {
    cwd,
    env: {
      PATH: process.env.PATH ?? '',
      HOME: root,
      LANG: 'C',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
      ...env,
    },
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  return { code: result.status, stdout: result.stdout, stderr: result.stderr }
}

function textOf(message: ChatMessage | undefined): string {
  return (message?.content ?? []).map((p) => (p.type === 'text' ? p.text : '')).join('\n')
}

function lastInput(request: CompletionRequest): { text: string; tools: number; session: boolean } {
  const index = request.messages.findLastIndex((m) => m.role === 'user')
  return {
    text: textOf(request.messages[index]),
    tools: request.messages.slice(index + 1).filter((m) => m.role === 'tool').length,
    session: textOf(request.messages[0]).includes('# Work session'),
  }
}

async function boot(script: (request: CompletionRequest) => FakeStep) {
  const guest = fakeGuest()
  guest.state.execResult = (body) => {
    const env = Object.fromEntries(
      Object.entries((body.env as Record<string, string> | undefined) ?? {}).map(([k, v]) => [k, toLocal(v)]),
    )
    if (String(body.cmd).includes('git worktree')) {
      const setup = run(REPO_SETUP, root, env)
      if (setup.code !== 0) return setup
      return {
        code: 0,
        stdout: `STATUS=created\nBASE=main\nBRANCH=${(body.env as Record<string, string>).BRANCH}\n`,
        stderr: '',
      }
    }
    return run(String(body.cmd), toLocal(String(body.cwd ?? '/workspace')), env)
  }
  h = await bootRuntime({ dir: dir(), script, guest, host: { compaction: false } })
  ;({ runtime, host, events, dm: chiefDm } = h)
}

const call: RuntimeHarness['call'] = (...args) => h.call(...args)

async function onlySession(): Promise<WorkSession> {
  await until(() => runtime.store.db.prepare('SELECT 1 FROM work_sessions').get() !== undefined, 8000)
  const [session] = await call<WorkSession[]>('listWorkSessions', {}, undefined, {})
  return session as WorkSession
}

function sessionCard(): (Message & { payload: WorkSessionPayload }) | undefined {
  return runtime.store.messages
    .list(chiefDm, { limit: 200 })
    .messages.find((m): m is Message & { payload: WorkSessionPayload } => m.payload?.type === 'work_session')
}

const SESSION_WORK = [
  'echo four >> a.txt',
  'git add a.txt',
  'git commit -qm wip',
  'echo five >> a.txt',
  'rm b.txt',
  'mkdir -p "docs dir"',
  'git mv c.txt "docs dir/c 2.txt"',
  "printf 'x' >> img.bin",
  "printf '\\211PNG\\r\\n\\032\\n\\000new' > art/logo.png",
  'rm gone.png',
  "printf 'GIF89a\\000new' > added.gif",
  'echo hi > "new file.txt"',
  'echo noise > ignored.log',
  "head -c 600000 /dev/zero | tr '\\0' 'a' | fold -w 100 > big.txt",
].join(' && ')

describe('work session changes', () => {
  it('measures a git worktree against the commit it started from, without touching its index', async () => {
    let stateSeen = ''
    await boot((request) => {
      const { text, tools, session } = lastInput(request)
      if (session) {
        if (text.includes('how is it')) {
          stateSeen = text
          return { text: 'All good.' }
        }
        if (tools === 0) return { toolCalls: [{ name: 'bash', arguments: { command: SESSION_WORK } }] }
        if (tools === 1)
          return { toolCalls: [{ name: 'session_finish', arguments: { summary: 'Done.', status: 'done' } }] }
        return { text: 'Closed.' }
      }
      if (text.includes('work on the app') && tools === 0)
        return {
          toolCalls: [
            { name: 'session_start', arguments: { title: 'Work on the app', goal: 'Changes.', repo: 'app' } },
          ],
        }
      return { text: 'Ok.' }
    })
    await call('postMessage', { conversationId: chiefDm }, { content: 'work on the app' })
    const session = await onlySession()
    await host.idle()

    const changes = await call<SessionChanges>('getWorkSessionChanges', { sessionId: session.id })
    expect(changes.available).toBe(true)
    expect(changes.base).toMatch(/^[0-9a-f]{40}$/)
    const byPath = Object.fromEntries(changes.files.map((f) => [f.path, f]))
    expect(Object.keys(byPath).sort()).toEqual(
      [
        'a.txt',
        'added.gif',
        'art/logo.png',
        'b.txt',
        'big.txt',
        'docs dir/c 2.txt',
        'gone.png',
        'img.bin',
        'new file.txt',
      ].sort(),
    )
    expect(byPath['a.txt']).toMatchObject({ status: 'modified', additions: 2, deletions: 0 })
    expect(byPath['b.txt']).toMatchObject({ status: 'deleted', additions: 0, deletions: 5 })
    expect(byPath['docs dir/c 2.txt']).toMatchObject({ status: 'renamed', oldPath: 'c.txt' })
    expect(byPath['img.bin']).toMatchObject({ status: 'modified', binary: true })
    expect(byPath['new file.txt']).toMatchObject({ status: 'added', additions: 1 })
    expect(changes.totals.files).toBe(9)

    const wt = toLocal(session.cwd as string)
    expect(run('git diff --cached --name-status', wt, {}).stdout.trim()).toBe('R100\tc.txt\tdocs dir/c 2.txt')

    const a = await call<SessionFileDiff>('getWorkSessionFileDiff', { sessionId: session.id }, undefined, {
      path: 'a.txt',
    })
    expect(a.patch).toContain('+four')
    expect(a.patch).toContain('+five')
    expect(a.truncated).toBe(false)
    const renamed = await call<SessionFileDiff>(
      'getWorkSessionFileDiff',
      { sessionId: session.id },
      undefined,
      { path: 'docs dir/c 2.txt' },
    )
    expect(renamed).toMatchObject({ oldPath: 'c.txt', status: 'renamed' })
    expect(renamed.patch).toContain('rename from c.txt')
    const big = await call<SessionFileDiff>('getWorkSessionFileDiff', { sessionId: session.id }, undefined, {
      path: 'big.txt',
    })
    expect(big.truncated).toBe(true)
    expect(Buffer.byteLength(big.patch)).toBeLessThanOrEqual(MAX_PATCH_BYTES)
    const image = await call<SessionFileDiff>(
      'getWorkSessionFileDiff',
      { sessionId: session.id },
      undefined,
      {
        path: 'img.bin',
      },
    )
    expect(image).toMatchObject({ binary: true, patch: '' })

    const images = (path: string) =>
      call<SessionFileImages>('getWorkSessionFileImages', { sessionId: session.id }, undefined, { path })
    const png = (tail: string) => Buffer.from(`\x89PNG\r\n\x1a\n\0${tail}`, 'latin1').toString('base64')
    expect(await images('art/logo.png')).toEqual({
      before: { bytes: 12, mediaType: 'image/png', data: png('old') },
      after: { bytes: 12, mediaType: 'image/png', data: png('new') },
    })
    expect(await images('gone.png')).toEqual({
      before: { bytes: 13, mediaType: 'image/png', data: png('gone') },
      after: null,
    })
    expect(await images('added.gif')).toMatchObject({ before: null, after: { mediaType: 'image/gif' } })
    await expect(images('img.bin')).rejects.toThrow()

    await until(() => sessionCard()?.payload.changes?.files === 9, 8000)
    expect(events.some((e) => e.type === 'work_session.files_changed')).toBe(true)
    const [listed] = await call<WorkSession[]>('listWorkSessions', {}, undefined, {})
    expect(listed?.changes).toMatchObject({ files: 9, additions: 6003 })

    await call('postMessage', { conversationId: session.conversationId }, { content: 'how is it looking?' })
    await host.idle()
    expect(stateSeen).toContain('Files changed since the session started (9')
    expect(stateSeen).toContain('a.txt +2 −0')
  })

  it('snapshots a folder without git and removes the snapshot with the session', async () => {
    let round = 0
    await boot((request) => {
      const { text, tools, session } = lastInput(request)
      if (session) {
        if (tools === 0 && round === 0) {
          round = 1
          return {
            toolCalls: [
              {
                name: 'bash',
                arguments: { command: 'echo hello > notes.md && mkdir -p sub && echo x > sub/y.txt' },
              },
            ],
          }
        }
        if (tools === 1)
          return { toolCalls: [{ name: 'session_finish', arguments: { summary: 'Notes.', status: 'done' } }] }
        return { text: 'Ok.' }
      }
      if (text.includes('write notes') && tools === 0)
        return {
          toolCalls: [{ name: 'session_start', arguments: { title: 'Notes', goal: 'Write notes.' } }],
        }
      return { text: 'Ok.' }
    })
    await call('postMessage', { conversationId: chiefDm }, { content: 'write notes' })
    const session = await onlySession()
    await host.idle()

    const shadow = join(root, '.milibot', 'sessions', `${session.id}.git`)
    expect(existsSync(shadow)).toBe(true)
    expect(existsSync(join(toLocal(session.cwd as string), '.git'))).toBe(false)
    const changes = await call<SessionChanges>('getWorkSessionChanges', { sessionId: session.id })
    expect(changes.files.map((f) => [f.path, f.status])).toEqual([
      ['notes.md', 'added'],
      ['sub/y.txt', 'added'],
    ])

    await until(() => sessionCard()?.payload.status === 'done', 8000)
    await call('deleteWorkSession', { sessionId: session.id })
    await until(() => !existsSync(shadow), 8000)
  })

  it('keeps the changes of a finished session after its folder is gone', async () => {
    await boot((request) => {
      const { text, tools, session } = lastInput(request)
      if (session) {
        if (tools === 0) return { toolCalls: [{ name: 'bash', arguments: { command: SESSION_WORK } }] }
        if (tools === 1)
          return { toolCalls: [{ name: 'session_finish', arguments: { summary: 'Done.', status: 'done' } }] }
        return { text: 'Closed.' }
      }
      if (text.includes('work on the app') && tools === 0)
        return {
          toolCalls: [
            { name: 'session_start', arguments: { title: 'Work on the app', goal: 'Changes.', repo: 'app' } },
          ],
        }
      return { text: 'Ok.' }
    })
    await call('postMessage', { conversationId: chiefDm }, { content: 'work on the app' })
    const session = await onlySession()
    await host.idle()
    const saved = () =>
      runtime.store.db
        .prepare('SELECT COUNT(*) AS n FROM work_session_patches WHERE session_id = ?')
        .get(session.id) as { n: number }
    await until(() => saved().n === 9, 8000)

    run('rm -rf "$WT"', root, { WT: toLocal(session.cwd as string) })
    const changes = await call<SessionChanges>('getWorkSessionChanges', { sessionId: session.id })
    expect(changes).toMatchObject({ available: true, totals: { files: 9 } })
    const diff = (path: string) =>
      call<SessionFileDiff>('getWorkSessionFileDiff', { sessionId: session.id }, undefined, { path })
    const a = await diff('a.txt')
    expect(a.patch).toContain('+four')
    expect(a.patch).toContain('+five')
    expect(await diff('docs dir/c 2.txt')).toMatchObject({ oldPath: 'c.txt', status: 'renamed' })
    expect((await diff('docs dir/c 2.txt')).patch).toContain('rename from c.txt')
    const big = await diff('big.txt')
    expect(big.truncated).toBe(true)
    expect(Buffer.byteLength(big.patch)).toBeLessThanOrEqual(MAX_PATCH_BYTES)
  })

  it('runs an approved plan in the project folder it names, made when missing', async () => {
    const PLAN = {
      title: 'Calculator',
      summary: 'A calculator web app.',
      body: '## Goal\nThe app.',
      steps: [{ title: 'Build it' }],
      execution: 'session',
      folder: '/workspace/calculator/',
    }
    await boot((request) => {
      const { text, tools, session } = lastInput(request)
      if (session) {
        if (tools === 0)
          return {
            toolCalls: [
              {
                name: 'bash',
                arguments: { command: 'echo "<h1>calc</h1>" > index.html && echo x > app.js' },
              },
            ],
          }
        if (tools === 1)
          return { toolCalls: [{ name: 'session_finish', arguments: { summary: 'Built.', status: 'done' } }] }
        return { text: 'Ok.' }
      }
      if (text.includes('plan the calculator') && tools === 0)
        return { toolCalls: [{ name: 'plan_write', arguments: PLAN }] }
      if (text.includes('plan the calculator') && tools === 1)
        return { toolCalls: [{ name: 'plan_submit', arguments: { plan: 'Calculator' } }] }
      return { text: 'Ok.' }
    })
    await call('postMessage', { conversationId: chiefDm }, { content: 'plan the calculator' })
    await until(
      () =>
        runtime.store.db.prepare("SELECT 1 FROM plans WHERE status = 'awaiting_approval'").get() !==
        undefined,
    )
    const [plan] = await call<Plan[]>('listPlans', {}, undefined, {})
    expect(plan?.folder).toBe('/workspace/calculator')
    await call<Plan>('approvePlan', { planId: plan!.id }, { execution: 'session' })
    const session = await onlySession()
    await host.idle()

    expect(session.cwd).toBe('/workspace/calculator')
    const brief = h.messages(session.conversationId)[0]?.content ?? ''
    expect(brief).toContain('Working directory: /workspace/calculator (the project folder')
    expect(existsSync(join(root, 'calculator', 'index.html'))).toBe(true)
    const changes = await call<SessionChanges>('getWorkSessionChanges', { sessionId: session.id })
    expect(changes.files.map((f) => [f.path, f.status])).toEqual([
      ['app.js', 'added'],
      ['index.html', 'added'],
    ])
  })

  it('works in an existing project folder, ignoring what its .gitignore ignores', async () => {
    const project = join(root, 'shop')
    mkdirSync(join(project, 'node_modules', 'dep'), { recursive: true })
    writeFileSync(join(project, '.gitignore'), 'node_modules/\n')
    writeFileSync(join(project, 'package.json'), '{}\n')
    for (let i = 0; i < 30; i++) writeFileSync(join(project, 'node_modules', 'dep', `f${i}.js`), 'x\n')
    const toolResults: string[] = []
    await boot((request) => {
      const { text, tools, session } = lastInput(request)
      const last = request.messages.at(-1)
      if (last?.role === 'tool') toolResults.push(textOf(last))
      if (session) {
        if (text.includes('how is it')) return { text: 'Fine.' }
        if (tools === 0)
          return {
            toolCalls: [
              {
                name: 'bash',
                arguments: {
                  command: 'echo "{\\"name\\":1}" > package.json && echo y > node_modules/dep/new.js',
                },
              },
            ],
          }
        return { text: 'Ok.' }
      }
      if (text.includes('work on the shop')) {
        const starts = [
          { title: 'Shop', goal: 'Change the shop.', folder: '/workspace/shop' },
          { title: 'Other', goal: 'Overlap.', folder: '/workspace/shop/src' },
          { title: 'Bad', goal: 'Reserved.', folder: '/workspace/.milibot/x' },
        ]
        const start = starts[tools]
        if (start) return { toolCalls: [{ name: 'session_start', arguments: start }] }
      }
      return { text: 'Ok.' }
    })
    await call('postMessage', { conversationId: chiefDm }, { content: 'work on the shop' })
    const session = await onlySession()
    await host.idle()

    expect(session.cwd).toBe('/workspace/shop')
    expect(toolResults[0]).toContain('in /workspace/shop')
    expect(toolResults[1]).toContain('overlaps /workspace/shop, where the open work session "Shop" works')
    expect(toolResults[2]).toContain('Invalid folder: /workspace/.milibot/x cannot be used')
    expect(await call<WorkSession[]>('listWorkSessions', {}, undefined, {})).toHaveLength(1)
    const changes = await call<SessionChanges>('getWorkSessionChanges', { sessionId: session.id })
    expect(changes).toMatchObject({ available: true })
    expect(changes.files.map((f) => [f.path, f.status])).toEqual([['package.json', 'modified']])
  })
})
