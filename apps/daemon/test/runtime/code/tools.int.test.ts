import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import type { ToolExecContext } from '@milibot/agent'
import type { Bot } from '@milibot/shared'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { CodeTools } from '../../../src/runtime/code/tools'
import { fakeGuest } from '../../support/fake-guest'
import { removeDir, tempDir } from '../../support/temp'

/** Stands for the VM's /workspace: the tools' scripts run here for real (bash, grep/find, git). */
let root: string

const toLocal = (path: string) => (path.startsWith('/workspace') ? join(root, path.slice(10)) : path)

/** `/fs/read` of the fake guest, on the real files. */
class LocalFiles extends Map<string, string | Uint8Array> {
  override get(path: string) {
    return existsSync(toLocal(path)) ? readFileSync(toLocal(path), 'utf8') : undefined
  }
}

function setup() {
  const guest = fakeGuest()
  guest.state.files = new LocalFiles()
  guest.state.execResult = (body) => {
    const env = Object.fromEntries(
      Object.entries((body.env as Record<string, string> | undefined) ?? {}).map(([k, v]) => [
        k,
        k === 'PATTERN' || k === 'REGEX' || k === 'GLOB' ? v : toLocal(v),
      ]),
    )
    const result = spawnSync('bash', ['-c', String(body.cmd)], {
      cwd: toLocal(String(body.cwd ?? '/workspace')),
      env: { PATH: process.env.PATH ?? '', HOME: root, LANG: 'C', GIT_CONFIG_NOSYSTEM: '1', ...env },
      input: typeof body.stdin === 'string' ? body.stdin : undefined,
      encoding: 'utf8',
    })
    return { code: result.status, stdout: result.stdout, stderr: result.stderr }
  }
  const client = guest.client('http://guest', 'fake-token')
  const tools = new CodeTools({
    vm: { guest: async () => client },
    defaultCwd: () => '/workspace/proj',
  })
  const execute = tools.execute.bind(tools)
  const ctx: ToolExecContext = {
    bot: { id: 'b1', slug: 'ana', displayNum: 4 } as Bot,
    conversationId: null,
    turnId: null,
    signal: new AbortController().signal,
  }
  return (name: string, args: Record<string, unknown>) =>
    execute(ctx, { id: 't1', name, arguments: args }).then((r) => ({
      text: r.content.map((p) => (p.type === 'text' ? p.text : '')).join(''),
      isError: r.isError === true,
      files: r.activity?.files,
    }))
}

function write(path: string, content: string) {
  const full = join(root, 'proj', path)
  mkdirSync(join(full, '..'), { recursive: true })
  writeFileSync(full, content)
}

beforeEach(() => {
  root = tempDir('code-tools')
  write('src/auth.ts', 'export function login() {\n  return session()\n}\n')
  write('src/deep/util.ts', 'export const LOGIN_TTL = 60\n')
  write('src/view.tsx', 'login\n')
  write('README.md', 'Login docs\n')
  write('node_modules/lib/index.ts', 'login\n')
})

afterEach(() => removeDir(root))

describe('code tools on real files', () => {
  it('grep finds matches, skips node_modules and honors glob and case', async () => {
    const run = setup()
    const found = await run('grep', { pattern: 'login', glob: '*.ts' })
    expect(found.isError).toBe(false)
    expect(found.text).toContain('src/auth.ts:1:export function login() {')
    expect(found.text).not.toContain('node_modules')
    expect(found.text).not.toContain('view.tsx')
    const loud = await run('grep', { pattern: 'login', ignore_case: true, path: 'src/deep' })
    expect(loud.text).toContain('LOGIN_TTL')
    expect((await run('grep', { pattern: 'nope_nothing' })).text).toBe('No matches for /nope_nothing/.')
  })

  it('glob lists files by pattern, newest first', async () => {
    const run = setup()
    const later = join(root, 'proj/src/deep/util.ts')
    const time = new Date(Date.now() + 60_000)
    const { utimesSync } = await import('node:fs')
    utimesSync(later, time, time)
    const listed = await run('glob', { pattern: '**/*.ts' })
    const files = listed.text.split('\n').slice(1)
    expect(files).toEqual(['src/deep/util.ts', 'src/auth.ts'])
    expect((await run('glob', { pattern: 'src/*.tsx' })).text).toContain('src/view.tsx')
  })

  it('apply_patch changes files all or nothing', async () => {
    const run = setup()
    const patch = [
      '--- a/src/auth.ts',
      '+++ b/src/auth.ts',
      '@@ -1,3 +1,3 @@',
      ' export function login() {',
      '-  return session()',
      '+  return token()',
      ' }',
      '--- /dev/null',
      '+++ b/src/new.ts',
      '@@ -0,0 +1 @@',
      '+export const created = true',
      '',
    ].join('\n')
    const ok = await run('apply_patch', { patch })
    expect(ok.text).toBe('Patch applied in /workspace/proj: src/auth.ts, src/new.ts.')
    expect(ok.files).toEqual([
      {
        path: '/workspace/proj/src/auth.ts',
        status: 'modified',
        additions: 1,
        deletions: 1,
        patch: '@@ -1,3 +1,3 @@\n export function login() {\n-  return session()\n+  return token()\n }',
        truncated: false,
      },
      {
        path: '/workspace/proj/src/new.ts',
        status: 'added',
        additions: 1,
        deletions: 0,
        patch: '@@ -0,0 +1 @@\n+export const created = true',
        truncated: false,
      },
    ])
    expect(readFileSync(join(root, 'proj/src/auth.ts'), 'utf8')).toContain('return token()')
    expect(readFileSync(join(root, 'proj/src/new.ts'), 'utf8')).toBe('export const created = true\n')
    const conflict = patch
      .replace('-  return session()', '-  return other()')
      .replace('src/new.ts', 'src/two.ts')
    const failed = await run('apply_patch', { patch: conflict })
    expect(failed.isError).toBe(true)
    expect(failed.text).toContain('Patch not applied')
    expect(() => readFileSync(join(root, 'proj/src/two.ts'))).toThrow()
  })

  it('apply_patch applies hunks without line ranges and Codex patches', async () => {
    const run = setup()
    write('src/math.ts', '/** old doc */\nexport const a = 1\n\nexport const b = 1\n')
    const bare = [
      '--- a/src/math.ts',
      '+++ b/src/math.ts',
      '@@',
      '-/** old doc */',
      '+/** new doc */',
      ' export const a = 1',
      '@@',
      '-export const b = 1',
      '+export const b = 2',
      '',
    ].join('\n')
    const ok = await run('apply_patch', { patch: bare })
    expect(ok.text).toBe('Patch applied in /workspace/proj: src/math.ts.')
    expect(ok.files?.[0]?.patch).toContain('@@ -1,2 +1,2 @@')
    expect(readFileSync(join(root, 'proj/src/math.ts'), 'utf8')).toBe(
      '/** new doc */\nexport const a = 1\n\nexport const b = 2\n',
    )
    const codex = [
      '*** Begin Patch',
      '*** Update File: src/math.ts',
      '@@',
      '-export const b = 2',
      '+export const b = 3',
      '*** Add File: src/extra.ts',
      '+export const c = 1',
      '*** Delete File: README.md',
      '*** End Patch',
    ].join('\n')
    const applied = await run('apply_patch', { patch: codex })
    expect(applied.text).toBe('Patch applied in /workspace/proj: src/math.ts, src/extra.ts, README.md.')
    expect(readFileSync(join(root, 'proj/src/math.ts'), 'utf8')).toContain('export const b = 3')
    expect(readFileSync(join(root, 'proj/src/extra.ts'), 'utf8')).toBe('export const c = 1\n')
    expect(existsSync(join(root, 'proj/README.md'))).toBe(false)
  })
})
