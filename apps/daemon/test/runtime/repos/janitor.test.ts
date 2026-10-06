import type { GuestExecRequest, TaskStatus } from '@milibot/shared'
import { beforeEach, describe, expect, it } from 'vitest'

import { WorktreeJanitor, type WorktreeJanitorDeps } from '../../../src/runtime/repos/janitor'
import { CLEANUP_SCRIPT } from '../../../src/runtime/repos/scripts/cleanup.generated'
import { WorktreeStore } from '../../../src/runtime/repos/store'
import { WorkspaceStore } from '../../../src/runtime/workspace-store'
import { openWorkspaceDb } from '../../../src/workspace-db/open'

const WT = '/workspace/worktrees/app'

let worktrees: WorktreeStore
let store: WorkspaceStore
let botId: string
let execs: GuestExecRequest[]
/** Paths `git worktree list` shows, with their branch ('' = detached). */
let listed: Map<string, string>
/** What the cleanup script answers for each path (default: removed). */
let outcomes: Map<string, string>
let vmRunning: boolean
let fetchFailed: boolean
let removedSessions: string[]
let prStatus: Map<string, TaskStatus>
let doneSessions: Set<string>
let busyBots: Set<string>
let openSessions: Set<string>

const guest = {
  exec: (req: GuestExecRequest) => {
    execs.push(req)
    if (req.cmd?.includes('worktree list --porcelain')) {
      const blocks = [`worktree /workspace/repos/app\nHEAD abc\nbranch refs/heads/main`]
      for (const [path, branch] of listed)
        blocks.push(`worktree ${path}\nHEAD def\n${branch ? `branch refs/heads/${branch}` : 'detached'}`)
      return Promise.resolve({ code: 0, stdout: `${blocks.join('\n\n')}\n`, stderr: '' })
    }
    if (req.cmd === CLEANUP_SCRIPT) {
      const lines = (req.stdin ?? '')
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          const [path = '', branch = ''] = line.split('|')
          return `RESULT=${path}|${outcomes.get(path) ?? 'removed'}|${listed.get(path) ?? branch}|0`
        })
      const fetch = fetchFailed ? 'FETCH=failed\n' : ''
      return Promise.resolve({ code: 0, stdout: `${fetch}${lines.join('\n')}\n`, stderr: '' })
    }
    return Promise.resolve({ code: 1, stdout: '', stderr: 'unexpected' })
  },
}

function janitor(overrides: Partial<WorktreeJanitorDeps> = {}): WorktreeJanitor {
  return new WorktreeJanitor({
    worktrees,
    vm: {
      runningGuest: () => {
        if (!vmRunning) throw new Error('VM not running')
        return guest as never
      },
      status: () => ({ state: vmRunning ? 'running' : 'stopped' }) as never,
      subscribe: () => () => {},
    },
    sessionDone: (id) => doneSessions.has(id),
    sessionWorktreeRemoved: (id) => removedSessions.push(id),
    pullRequestStatus: (_repo, branch) => prStatus.get(branch) ?? null,
    sessionOpen: (id) => openSessions.has(id),
    botBusy: (id) => busyBots.has(id),
    ...overrides,
  })
}

/** A session's worktree, or a chat one (each of a bot of its own: a bot has one per repository). */
function worktree(name: string, sessionId: string | null = null, branch = `bot/ana/${name}`) {
  const row = worktrees.insert({
    botId: sessionId ? botId : store.bots.create({ name: `Bot ${name}` }).id,
    repoName: 'app',
    repoUrl: null,
    worktreePath: `${WT}/${name}`,
    branch,
    baseBranch: 'main',
    sessionId,
  })
  listed.set(row.worktreePath, branch)
  return row
}

const cleanupInput = () => execs.find((e) => e.cmd === CLEANUP_SCRIPT)?.stdin ?? null
const status = (id: string) => worktrees.get(id)?.status

beforeEach(() => {
  const db = openWorkspaceDb(':memory:')
  worktrees = new WorktreeStore(db)
  store = new WorkspaceStore(db)
  botId = store.bots.create({ name: 'Ana' }).id
  execs = []
  listed = new Map()
  outcomes = new Map()
  vmRunning = true
  fetchFailed = false
  removedSessions = []
  prStatus = new Map()
  doneSessions = new Set()
  busyBots = new Set()
  openSessions = new Set()
})

describe('worktree janitor', () => {
  it('removes the worktree of a session that ended and saved its patches, never one still open', async () => {
    const ended = worktree('ended', 'ws_ended')
    const open = worktree('open', 'ws_open')
    doneSessions.add('ws_ended')

    await janitor().run()

    expect(cleanupInput()).toBe(`${WT}/ended|bot/ana/ended|-\n`)
    expect(status(ended.id)).toBe('released')
    expect(status(open.id)).toBe('active')
    expect(removedSessions).toEqual(['ws_ended'])
  })

  it('removes a chat worktree once its pull request is merged or closed and its chat is idle', async () => {
    const merged = worktree('merged')
    const closed = worktree('closed')
    const open = worktree('open')
    prStatus.set('bot/ana/merged', 'done').set('bot/ana/closed', 'failed').set('bot/ana/open', 'review')

    await janitor().run()

    expect(cleanupInput()).toBe(`${WT}/merged|bot/ana/merged|pr_done\n${WT}/closed|bot/ana/closed|pr_done\n`)
    expect([status(merged.id), status(closed.id), status(open.id)]).toEqual([
      'released',
      'released',
      'active',
    ])
  })

  it('leaves a chat worktree alone while any lane of its bot works', async () => {
    const row = worktree('merged')
    prStatus.set('bot/ana/merged', 'done')
    busyBots.add(row.botId)

    await janitor().run()

    expect(cleanupInput()).toBeNull()
  })

  it('keeps a chat worktree a session checked out until that session ends, even between its turns', async () => {
    // A session ran repo_checkout (the bot's chat worktree), pushed and reported its pull request done while
    // its turn went on.
    const row = worktree('shared')
    worktrees.usedBySession(row.id, 'ws_using')
    openSessions.add('ws_using')
    prStatus.set('bot/ana/shared', 'done')
    busyBots.add(row.botId)
    await janitor().run()
    expect(cleanupInput()).toBeNull()

    busyBots.delete(row.botId)
    await janitor().run()
    expect(cleanupInput()).toBeNull()

    openSessions.delete('ws_using')
    await janitor().run()
    expect(cleanupInput()).toBe(`${WT}/shared|bot/ana/shared|pr_done\n`)
    expect(status(row.id)).toBe('released')
    expect(worktrees.sessionsUsing(row.id)).toEqual([])
  })

  it('keeps a chat worktree in detached HEAD (a pull request under test) while the session that made it is open', async () => {
    const row = worktree('qa', null, 'bot/marco/qa')
    listed.set(row.worktreePath, '')
    worktrees.usedBySession(row.id, 'ws_qa')
    openSessions.add('ws_qa')
    prStatus.set('bot/marco/qa', 'failed')

    await janitor().run()
    expect(cleanupInput()).toBeNull()

    openSessions.delete('ws_qa')
    await janitor().run()
    expect(cleanupInput()).toBe(`${WT}/qa|bot/marco/qa|pr_done\n`)
  })

  it('keeps the row of a worktree the script kept, and finds a pull request by the branch it was renamed to', async () => {
    const renamed = worktree('renamed', null, 'bot/ana/first-name')
    listed.set(renamed.worktreePath, 'bot/ana/renamed')
    prStatus.set('bot/ana/renamed', 'done')
    const dirty = worktree('dirty', 'ws_dirty')
    doneSessions.add('ws_dirty')
    outcomes.set(dirty.worktreePath, 'kept:dirty')

    await janitor().run()

    expect(worktrees.get(renamed.id)).toMatchObject({ status: 'released', branch: 'bot/ana/renamed' })
    expect(status(dirty.id)).toBe('active')
    expect(removedSessions).toEqual([])
  })

  it('releases rows of worktrees that no longer exist, without running the cleanup', async () => {
    const gone = worktree('gone', 'ws_gone')
    listed.delete(gone.worktreePath)
    const live = worktree('live')

    await janitor().run()

    expect(status(gone.id)).toBe('released')
    expect(status(live.id)).toBe('active')
    expect(removedSessions).toEqual(['ws_gone'])
    expect(cleanupInput()).toBeNull()
  })

  it('releases nothing when the worktree list cannot be read, and does nothing while the VM is down', async () => {
    const row = worktree('kept')
    listed.delete(row.worktreePath)
    const failing = {
      exec: () => Promise.resolve({ code: 128, stdout: '', stderr: 'fatal' }),
    }
    await janitor({
      vm: { runningGuest: () => failing as never, status: () => ({}) as never, subscribe: () => () => {} },
    }).run()
    expect(status(row.id)).toBe('active')

    vmRunning = false
    await janitor().run()
    expect(execs).toEqual([])
  })

  it('never touches a row outside the worktrees folder', async () => {
    const row = worktrees.insert({
      botId,
      repoName: 'app',
      repoUrl: null,
      worktreePath: '/workspace/projects/app',
      branch: 'bot/ana/elsewhere',
      baseBranch: null,
      sessionId: 'ws_elsewhere',
    })
    doneSessions.add('ws_elsewhere')

    await janitor().run()

    expect(status(row.id)).toBe('active')
    expect(execs).toEqual([])
  })

  it('logs a sweep that removed nothing once per change, and a failed fetch as a warning', async () => {
    const logs: Array<[string, string, unknown]> = []
    const j = janitor({ log: (level, msg, data) => logs.push([level, msg, data]) })
    const dirty = worktree('dirty', 'ws_dirty')
    doneSessions.add('ws_dirty')
    outcomes.set(dirty.worktreePath, 'kept:dirty')

    await j.run()
    await j.run()
    expect(logs).toEqual([
      ['info', 'no worktree removed', { repo: 'app', kept: [`${dirty.worktreePath} (dirty)`] }],
    ])

    fetchFailed = true
    outcomes.set(dirty.worktreePath, 'kept:fetch_failed')
    await j.run()
    await j.run()
    expect(logs.slice(1)).toEqual([
      ['warn', 'worktree cleanup skipped: fetch failed', { repo: 'app', kept: 1 }],
    ])

    fetchFailed = false
    outcomes.delete(dirty.worktreePath)
    await j.run()
    expect(logs.slice(2).map(([, msg]) => msg)).toEqual(['worktrees removed'])
  })
})
