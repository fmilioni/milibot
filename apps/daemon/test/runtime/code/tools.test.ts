import type { ToolExecContext } from '@milibot/agent'
import type { Bot } from '@milibot/shared'
import { describe, expect, it } from 'vitest'

import { CodeTools, killedOwnShellHint } from '../../../src/runtime/code/tools'
import { fakeGuest } from '../../support/fake-guest'

function setup(cwd: string | null = null) {
  const guest = fakeGuest()
  const client = guest.client('http://guest', 'fake-token')
  const tools = new CodeTools({
    vm: { guest: async () => client },
    defaultCwd: () => cwd,
  })
  const execute = tools.execute.bind(tools)
  const ctx: ToolExecContext = {
    bot: { id: 'b1', slug: 'ana', displayNum: 4 } as Bot,
    conversationId: null,
    turnId: null,
    signal: new AbortController().signal,
  }
  const run = (name: string, args: Record<string, unknown>) =>
    execute(ctx, { id: 't1', name, arguments: args }).then((r) => ({
      text: r.content.map((p) => (p.type === 'text' ? p.text : '')).join(''),
      isError: r.isError === true,
      files: r.activity?.files,
    }))
  return { guest, run }
}

describe('file tools of API bots', () => {
  it('file_edit applies several edits at once, or none', async () => {
    const { guest, run } = setup('/workspace/sessions/ana-1')
    guest.state.files.set('/workspace/sessions/ana-1/app.ts', 'const a = 1\nconst b = 2\n')
    const ok = await run('file_edit', {
      path: 'app.ts',
      edits: [
        { old_text: 'const a = 1', new_text: 'const a = 10' },
        { old_text: 'const b = 2', new_text: 'const b = 20' },
      ],
    })
    expect(ok.text).toBe('Edited /workspace/sessions/ana-1/app.ts (2 replacements)')
    expect(ok.files).toEqual([
      {
        path: '/workspace/sessions/ana-1/app.ts',
        status: 'modified',
        additions: 2,
        deletions: 2,
        patch: '@@ -1,2 +1,2 @@\n-const a = 1\n-const b = 2\n+const a = 10\n+const b = 20',
        truncated: false,
      },
    ])
    expect(guest.state.files.get('/workspace/sessions/ana-1/app.ts')).toBe('const a = 10\nconst b = 20\n')
    const failed = await run('file_edit', {
      path: 'app.ts',
      edits: [
        { old_text: 'const a = 10', new_text: 'x' },
        { old_text: 'missing', new_text: 'y' },
      ],
    })
    expect(failed.isError).toBe(true)
    expect(failed.text).toContain('edits[1]: the old text was not found')
    expect(guest.state.files.get('/workspace/sessions/ana-1/app.ts')).toBe('const a = 10\nconst b = 20\n')
    // The single-replacement form still works.
    const single = await run('file_edit', { path: 'app.ts', old_string: 'const a = 10', new_string: 'a' })
    expect(single.isError).toBe(false)
  })

  it('file_write reports a new file as added and an overwrite as a diff', async () => {
    const { guest, run } = setup()
    const created = await run('file_write', { path: 'notes.md', content: 'a\nb\n' })
    expect(created.files).toEqual([
      {
        path: '/workspace/notes.md',
        status: 'added',
        additions: 2,
        deletions: 0,
        patch: '@@ -0,0 +1,2 @@\n+a\n+b',
        truncated: false,
      },
    ])
    expect(guest.state.files.get('/workspace/notes.md')).toBe('a\nb\n')
    const replaced = await run('file_write', { path: 'notes.md', content: 'a\nc\n' })
    expect(replaced.files?.[0]).toMatchObject({ status: 'modified', additions: 1, deletions: 1 })
    expect(replaced.files?.[0]?.patch).toBe('@@ -1,2 +1,2 @@\n a\n-b\n+c')
  })

  it('file_read reads a range of lines', async () => {
    const { guest, run } = setup()
    guest.state.files.set('/workspace/notes.txt', ['l1', 'l2', 'l3', 'l4', 'l5'].join('\n'))
    const result = await run('file_read', { path: 'notes.txt', start_line: 2, end_line: 3 })
    expect(result.text).toMatch(/2\tl2\n\s*3\tl3/)
    expect(result.text).not.toContain('l4')
  })

  it('grep and glob run in the working directory and shape the output', async () => {
    const { guest, run } = setup('/workspace/sessions/ana-1')
    guest.state.execResult = (body) => {
      const env = body.env as Record<string, string>
      if (env.PATTERN) return { code: 0, stdout: './src/a.ts:3:login()\n', stderr: '' }
      return { code: 0, stdout: '5\tsrc/a.ts\n9\tsrc/b.ts\n', stderr: '' }
    }
    const found = await run('grep', { pattern: 'login', glob: '*.ts' })
    expect(found.text).toBe('src/a.ts:3:login()')
    const grepCall = guest.state.execs.at(-1) as Record<string, unknown>
    expect(grepCall).toMatchObject({ user: 'bot-ana', cwd: '/workspace/sessions/ana-1', bot: 'ana' })
    expect(grepCall.env).toMatchObject({ SEARCH_DIR: '/workspace/sessions/ana-1', TARGET: '.', GLOB: '*.ts' })
    const listed = await run('glob', { pattern: '*.ts' })
    expect(listed.text).toContain('src/b.ts\nsrc/a.ts')
    guest.state.execResult = () => ({ code: 1, stdout: '', stderr: '' })
    expect((await run('grep', { pattern: 'nothing' })).text).toBe('No matches for /nothing/.')
  })

  it('apply_patch reports the files it changed, or why nothing changed', async () => {
    const { guest, run } = setup('/workspace/sessions/ana-1')
    guest.state.execResult = () => ({
      code: 0,
      stdout: '1\t0\tsrc/a.ts\n-\t-\tsrc/b.ts\n::applied::\n',
      stderr: '',
    })
    const ok = await run('apply_patch', { patch: '--- a/src/a.ts\n+++ b/src/a.ts\n' })
    expect(ok.text).toBe('Patch applied in /workspace/sessions/ana-1: src/a.ts, src/b.ts.')
    expect(ok.files?.map((f) => [f.path, f.additions, f.deletions])).toEqual([
      ['/workspace/sessions/ana-1/src/a.ts', 1, 0],
      ['/workspace/sessions/ana-1/src/b.ts', 0, 0],
    ])
    expect((guest.state.execs.at(-1) as Record<string, unknown>).stdin).toBe(
      '--- a/src/a.ts\n+++ b/src/a.ts\n',
    )
    guest.state.execResult = () => ({ code: 1, stdout: '', stderr: 'error: patch failed: src/a.ts:3' })
    const failed = await run('apply_patch', { patch: 'x' })
    expect(failed.isError).toBe(true)
    expect(failed.text).toContain('patch failed: src/a.ts:3')
  })
})

describe('bash and apply_patch output', () => {
  it('bash asks for no colors and strips terminal escapes', async () => {
    const { guest, run } = setup()
    guest.state.execResult = () => ({
      code: 1,
      stdout: '\x1b[32mok\x1b[39m\n',
      stderr: '\x1b[31mFAIL\x1b[0m',
    })
    const result = await run('bash', { command: 'npx vitest run' })
    expect(result.text).toBe('exit code: 1\nstdout:\nok\n\nstderr:\nFAIL')
    expect((guest.state.execs.at(-1) as Record<string, unknown>).env).toMatchObject({
      NO_COLOR: '1',
      FORCE_COLOR: '0',
    })
  })

  it('apply_patch places bare hunks and names the cwd a missing path was looked for in', async () => {
    const { guest, run } = setup('/workspace/proj')
    guest.state.files.set('/workspace/proj/src/a.ts', 'one\ntwo\n')
    guest.state.execResult = () => ({ code: 0, stdout: '1\t1\tsrc/a.ts\n::applied::\n', stderr: '' })
    const ok = await run('apply_patch', { patch: '--- a/src/a.ts\n+++ b/src/a.ts\n@@\n-two\n+2\n' })
    expect(ok.isError).toBe(false)
    expect((guest.state.execs.at(-1) as Record<string, unknown>).stdin).toBe(
      '--- a/src/a.ts\n+++ b/src/a.ts\n@@ -2,1 +2,1 @@\n-two\n+2\n',
    )
    const context = await run('apply_patch', { patch: '--- a/src/a.ts\n+++ b/src/a.ts\n@@\n-nope\n+2\n' })
    expect(context.isError).toBe(true)
    expect(context.text).toContain('hunk 1 (src/a.ts): context not found')

    guest.state.files.set('/workspace/calc/src/p.ts', 'x\n')
    const execs = guest.state.execs.length
    const missing = await run('apply_patch', {
      patch: '--- a/calc/src/p.ts\n+++ b/calc/src/p.ts\n@@\n-x\n+y\n',
    })
    expect(missing.text).toBe(
      'Patch not applied (nothing was changed):\ncalc/src/p.ts does not exist in /workspace/proj (the cwd ' +
        'used; the paths in the patch are relative to it). /workspace/calc/src/p.ts exists: pass cwd ' +
        '"/workspace" or make the paths relative to /workspace/proj.',
    )
    expect(guest.state.execs.length).toBe(execs)

    guest.state.execResult = () => ({
      code: 1,
      stdout: '',
      stderr: 'error: calc/src/p.ts: No such file or directory',
    })
    const ranged = '--- a/calc/src/p.ts\n+++ b/calc/src/p.ts\n@@ -1 +1 @@\n-x\n+y\n'
    const gitMissing = await run('apply_patch', { patch: ranged })
    expect(gitMissing.text).toContain('does not exist in /workspace/proj (the cwd used')
    expect(gitMissing.text).toContain('/workspace/calc/src/p.ts exists: pass cwd "/workspace"')
  })
})

describe('bash hints', () => {
  it('explains a pkill -f that died from a signal', () => {
    const hint = killedOwnShellHint('pkill -f "vite --config /tmp/v.ts"; echo ok', 144, null)
    expect(hint).toContain("pkill -f '[v]ite --config'")
    expect(killedOwnShellHint('pgrep -af node | head', null, 'SIGTERM')).not.toBeNull()
    expect(killedOwnShellHint('pkill --full vite', 143, null)).not.toBeNull()
    expect(killedOwnShellHint('killall node', 137, null)).not.toBeNull()
    expect(killedOwnShellHint('pkill -f vite', 1, null)).toBeNull()
    expect(killedOwnShellHint('pkill vite', 143, null)).toBeNull()
    expect(killedOwnShellHint('sleep 100', 137, null)).toBeNull()
  })
})
