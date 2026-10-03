import { spawnSync } from 'node:child_process'
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { REPO_INSTRUCTIONS_FILE_MAX } from '@milibot/agent/prompts'
import { describe, expect, it } from 'vitest'

import type { ToolExecContext } from '@milibot/agent'
import type { Bot } from '@milibot/shared'

import { readRepoInstructions, RepoTools } from '../../../src/runtime/repos'
import type { WorktreeStore } from '../../../src/runtime/repos/store'
import type { GuestClient } from '../../../src/runtime/vm'
import type { WorkspaceStore } from '../../../src/runtime/workspace-store'
import { useTempDir } from '../../support/temp'

const temp = useTempDir('repo-instructions')

/**
 * A guest whose `/exec` runs node requests locally (the script needs only Node), with the VM's /workspace at
 * `ws` when given; anything else (the checkout script) answers `STATUS=reused`.
 */
function localGuest(execs: Array<Record<string, unknown>> = [], ws?: string): GuestClient {
  const into = (text: string) => (ws ? text.replaceAll('/workspace', ws) : text)
  const back = (text: string) => (ws ? text.replaceAll(ws, '/workspace') : text)
  return {
    exec: async (req: { argv?: string[]; stdin?: string }) => {
      execs.push(req)
      if (!req.argv) return { code: 0, stdout: 'STATUS=reused\nBRANCH=bot/ana/work\nBASE=main\n', stderr: '' }
      const [cmd, ...args] = req.argv
      const r = spawnSync(cmd as string, args, { input: into(req.stdin ?? ''), encoding: 'utf8' })
      return { code: r.status, stdout: back(r.stdout), stderr: r.stderr, signal: null, timedOut: false }
    },
  } as unknown as GuestClient
}

function write(path: string, text: string) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
}

const bot = { slug: 'ana' }

describe('readRepoInstructions', () => {
  const setup = () => {
    const ws = join(temp(), 'workspace')
    const repo = join(ws, 'app')
    mkdirSync(join(repo, '.git'), { recursive: true })
    const read = (paths: string[], guest = localGuest()) =>
      readRepoInstructions(guest, bot, paths, undefined, ws).then((files) =>
        files.map((f) => ({ ...f, path: f.path.slice(ws.length) })),
      )
    return { ws, repo, read }
  }

  it('reads a repository with only CLAUDE.md, or only AGENTS.md', async () => {
    const { ws, repo, read } = setup()
    write(join(repo, 'CLAUDE.md'), '# Claude rules\n')
    const other = join(ws, 'lib')
    mkdirSync(join(other, '.git'), { recursive: true })
    write(join(other, 'AGENTS.md'), '# Agents rules\n')
    expect(await read([join(repo, 'src')])).toEqual([
      { path: '/app/CLAUDE.md', bytes: 15, truncated: false, content: '# Claude rules\n' },
    ])
    expect((await read([other])).map((f) => f.path)).toEqual(['/lib/AGENTS.md'])
  })

  it('keeps one file when both names have the same text or are the same file, both when they differ', async () => {
    const { ws, read } = setup()
    const same = join(ws, 'same')
    mkdirSync(join(same, '.git'), { recursive: true })
    write(join(same, 'CLAUDE.md'), 'Rules\n')
    write(join(same, 'AGENTS.md'), '  Rules\n\n')
    const linked = join(ws, 'linked')
    mkdirSync(join(linked, '.git'), { recursive: true })
    write(join(linked, 'AGENTS.md'), 'Linked rules\n')
    symlinkSync('AGENTS.md', join(linked, 'CLAUDE.md'))
    const both = join(ws, 'both')
    mkdirSync(join(both, '.git'), { recursive: true })
    write(join(both, 'CLAUDE.md'), 'For Claude\n')
    write(join(both, 'AGENTS.md'), 'For agents\n')
    expect((await read([same, linked, both])).map((f) => f.path)).toEqual([
      '/same/CLAUDE.md',
      '/linked/CLAUDE.md',
      '/both/CLAUDE.md',
      '/both/AGENTS.md',
    ])
  })

  it('walks from the repository root down to the folder of a file, each file once', async () => {
    const { repo, read } = setup()
    write(join(repo, 'CLAUDE.md'), 'root\n')
    write(join(repo, 'apps/daemon/CLAUDE.md'), 'daemon\n')
    write(join(repo, 'apps/daemon/src/main.ts'), '')
    write(join(repo, 'apps/desktop/AGENTS.md'), 'desktop\n')
    const files = await read([
      join(repo, 'apps/daemon/src/main.ts'),
      join(repo, 'apps/daemon/src/new/file.ts'),
      join(repo, 'apps/desktop'),
    ])
    expect(files.map((f) => f.path)).toEqual([
      '/app/CLAUDE.md',
      '/app/apps/daemon/CLAUDE.md',
      '/app/apps/desktop/AGENTS.md',
    ])
  })

  it('finds the root of a worktree, whose .git is a file', async () => {
    const { ws, read } = setup()
    const wt = join(ws, 'worktrees/app/ana')
    write(join(wt, '.git'), 'gitdir: /workspace/repos/app/.git/worktrees/ana\n')
    write(join(wt, 'AGENTS.md'), 'wt\n')
    write(join(ws, 'worktrees/CLAUDE.md'), 'outside the repository\n')
    expect((await read([join(wt, 'src/x.ts')])).map((f) => f.path)).toEqual(['/worktrees/app/ana/AGENTS.md'])
  })

  it('gives nothing outside a repository and never looks above the workspace', async () => {
    const { ws, read } = setup()
    mkdirSync(join(temp(), '.git'))
    write(join(temp(), 'CLAUDE.md'), 'above\n')
    write(join(ws, 'notes/CLAUDE.md'), 'not a repo\n')
    expect(await read([join(ws, 'notes'), '/etc', join(temp(), 'x')])).toEqual([])
  })

  it('cuts a long file at a line end and reports its size', async () => {
    const { repo, read } = setup()
    const line = `${'x'.repeat(99)}\n`
    write(join(repo, 'CLAUDE.md'), line.repeat(1000))
    const [file] = await read([repo])
    expect(file?.bytes).toBe(100_000)
    expect(file?.truncated).toBe(true)
    expect(file?.content.length).toBe(Math.floor(REPO_INSTRUCTIONS_FILE_MAX / 100) * 100)
    expect(file?.content.endsWith('\n')).toBe(true)
  })

  it('reads as the bot in one exec, and makes none without a path in the workspace', async () => {
    const { repo, read } = setup()
    const execs: Array<Record<string, unknown>> = []
    await read([repo, join(repo, 'a'), join(repo, 'b')], localGuest(execs))
    await read(['relative/path', '/tmp'], localGuest(execs))
    expect(execs).toHaveLength(1)
    expect(execs[0]).toMatchObject({ user: 'bot-ana' })
  })
})

describe('repo_checkout', () => {
  it('returns the instruction files of the worktree root, each in its own part', async () => {
    const ws = join(temp(), 'workspace')
    const wt = join(ws, 'worktrees/app/ana')
    write(join(wt, '.git'), 'gitdir: x\n')
    write(join(wt, 'CLAUDE.md'), '# Root rules\n')
    write(join(wt, 'apps/daemon/CLAUDE.md'), '# Daemon rules\n')
    const guest = localGuest([], ws)
    const row = {
      id: 'wt_1',
      botId: 'b1',
      repoName: 'app',
      repoUrl: null,
      worktreePath: '/workspace/worktrees/app/ana',
      branch: 'bot/ana/work',
      baseBranch: 'main',
      sessionId: null,
      status: 'active',
      createdAt: 0,
    }
    const tools = new RepoTools({
      vm: { guest: async () => guest },
      store: {} as WorkspaceStore,
      worktrees: { active: () => row } as unknown as WorktreeStore,
    })
    const ctx: ToolExecContext = {
      bot: { id: 'b1', slug: 'ana', name: 'Ana' } as Bot,
      conversationId: null,
      turnId: null,
      signal: new AbortController().signal,
    }
    const result = await tools.execute(ctx, { id: 't1', name: 'repo_checkout', arguments: { repo: 'app' } })
    const texts = result.content.map((p) => (p.type === 'text' ? p.text : ''))
    expect(texts).toHaveLength(2)
    expect(texts[0]).toContain('Worktree ready (reused): /workspace/worktrees/app/ana')
    expect(texts[1]).toMatch(/^<repository_instructions path="\/workspace\/worktrees\/app\/ana\/CLAUDE.md"/)
    expect(texts[1]).toContain('# Root rules')
  })
})
