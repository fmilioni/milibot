import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  DIFF_SCRIPT_ENV,
  DIFF_SCRIPTS,
  parseBaseline,
  parseChanges,
} from '../../../src/runtime/sessions/diff'
import { removeDir, tempDir } from '../../support/temp'

let root: string
let folder: string
let shadow: string

beforeEach(() => {
  root = tempDir('session-baseline')
  folder = join(root, 'workspace', 'app')
  shadow = join(root, 'workspace', '.milibot', 'sessions', 'wses_1.git')
  mkdirSync(folder, { recursive: true })
})
afterEach(() => removeDir(root))

function run(script: string, env: Record<string, string> = {}) {
  const result = spawnSync('bash', ['-c', script], {
    cwd: root,
    env: {
      PATH: process.env.PATH ?? '',
      HOME: root,
      LANG: 'C',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
      SESSION_CWD: folder,
      SHADOW_DIR: shadow,
      ...DIFF_SCRIPT_ENV,
      ...env,
    },
    encoding: 'utf8',
  })
  if (result.status !== 0) throw new Error(`exit ${result.status}: ${result.stderr}`)
  return result.stdout
}

const write = (path: string, content = 'x\n') => {
  mkdirSync(join(folder, path, '..'), { recursive: true })
  writeFileSync(join(folder, path), content)
}

const baseline = (maxFiles = 5, maxKb = 1024) =>
  parseBaseline(
    run(DIFF_SCRIPTS.baseline, { MODE: 'git', MAX_FILES: String(maxFiles), MAX_KB: String(maxKb) }),
  )

function changes(result: ReturnType<typeof baseline>) {
  if ('error' in result) throw new Error(result.error)
  const env = { MODE: result.mode, BASE: result.base, FILE_PATH: '', OLD_PATH: '', MAX_PATCH: '100000' }
  return parseChanges(run(DIFF_SCRIPTS.changes, env)).map((f) => `${f.status} ${f.path}`)
}

describe('session baseline', () => {
  it("counts only what the folder's .gitignore keeps, and never shows ignored files", () => {
    write('package.json', '{}\n')
    write('.gitignore', 'node_modules/\ndist\n')
    for (let i = 0; i < 8; i++) write(`node_modules/dep/file${i}.js`)
    write('dist/big.js', 'y'.repeat(4 * 1024 * 1024))
    const result = baseline()
    expect(result).toMatchObject({ mode: 'shadow' })

    write('src/index.js', 'console.log(1)\n')
    write('package.json', '{"name":"app"}\n')
    write('node_modules/dep/new.js')
    write('dist/other.js')
    expect(changes(result)).toEqual(['modified package.json', 'added src/index.js'])
  })

  it('refuses a snapshot too large and leaves no shadow repository behind', () => {
    for (let i = 0; i < 8; i++) write(`lib/file${i}.js`)
    expect(baseline()).toEqual({ error: 'too_large' })
    expect(existsSync(shadow)).toBe(false)

    removeDir(join(folder, 'lib'))
    write('big.bin', 'z'.repeat(2 * 1024 * 1024))
    expect(baseline(5, 1024)).toEqual({ error: 'too_large' })
    expect(existsSync(shadow)).toBe(false)
  })

  it('hides the dependency and cache folders of common toolchains without a .gitignore', () => {
    for (let i = 0; i < 8; i++) write(`node_modules/dep/file${i}.js`)
    const result = baseline()
    expect(result).toMatchObject({ mode: 'shadow' })
    write('app.py')
    write('node_modules/dep/new.js')
    write('__pycache__/app.cpython-312.pyc')
    write('.venv/lib/site.py')
    write('target/debug/app')
    write('pkg/vendor/mod.go')
    expect(changes(result)).toEqual(['added app.py'])
  })

  it('hides untracked dependency folders in a repository but still shows tracked ones', () => {
    write('vendor/kept.php')
    run('cd "$SESSION_CWD" && git init -q && git add -A && git commit -qm init')
    const result = baseline()
    expect(result).toMatchObject({ mode: 'git' })
    write('vendor/kept.php', 'changed\n')
    write('node_modules/dep/index.js')
    write('src/main.ts')
    expect(changes(result)).toEqual(['added src/main.ts', 'modified vendor/kept.php'])
  })

  it('snapshots an empty folder', () => {
    const result = baseline()
    expect(result).toMatchObject({ mode: 'shadow' })
    write('notes.md')
    expect(changes(result)).toEqual(['added notes.md'])
  })

  it('measures a repository without commits from the empty tree', () => {
    run('cd "$SESSION_CWD" && git init -q && printf "a.log\\n" > .gitignore && echo 1 > a.txt')
    const result = baseline()
    expect(result).toEqual({ mode: 'git', base: '4b825dc642cb6eb9a060e54bf8d69288fbee4904' })
    write('a.log')
    expect(changes(result)).toEqual(['added .gitignore', 'added a.txt'])
  })

  it('keeps measuring against the snapshot after the bot runs git init in the folder', () => {
    write('a.txt', 'one\n')
    const result = baseline()
    expect(result).toMatchObject({ mode: 'shadow' })
    run(
      'cd "$SESSION_CWD" && git init -q && echo two >> a.txt && echo b > b.txt && git add -A && git commit -qm init',
    )
    expect(existsSync(join(folder, '.git', 'HEAD'))).toBe(true)
    expect(changes(result)).toEqual(['modified a.txt', 'added b.txt'])
  })
})
