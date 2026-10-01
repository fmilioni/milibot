import { execFileSync, spawnSync } from 'node:child_process'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { CDP_PORT_BASE } from '@milibot/shared/portable/platform'
import { afterAll, describe, expect, it } from 'vitest'

import { CLI_WRAPPER, ensureGuestFile, GUEST_FILES } from '../src/guest-files.ts'

const BIN = new URL('../../guest/bin/', import.meta.url)
const TMP = mkdtempSync(join(tmpdir(), 'milibot-guest-files-'))
afterAll(() => rmSync(TMP, { recursive: true, force: true }))

const source = (name: string) => readFileSync(new URL(name, BIN), 'utf8')
const guestFile = (path: string) => GUEST_FILES.find((f) => f.path === path)!

describe('embedded guest files', () => {
  it('are the executable scripts of vm/guest/bin', () => {
    expect(CLI_WRAPPER).toBe(source('cli-wrapper'))
    expect(guestFile('/usr/local/bin/codex').content).toBe(CLI_WRAPPER)
    expect(guestFile('/usr/local/bin/gh').content).toBe(source('gh'))
    expect(guestFile('/usr/local/bin/milibot-browser').content).toBe(source('milibot-browser'))
    for (const name of ['cli-wrapper', 'gh', 'milibot-browser']) {
      expect(statSync(new URL(name, BIN)).mode & 0o111).toBe(0o111)
    }
    for (const file of GUEST_FILES) expect(file.mode).toBe(0o755)
  })
})

describe('ensureGuestFile', () => {
  const file = { path: '/usr/local/bin/tool', content: '#!/bin/sh\necho v2\n', mode: 0o755 }
  const target = (root: string) => join(root, file.path)

  it('installs a missing file, then leaves it alone', () => {
    const root = mkdtempSync(join(TMP, 'root-'))
    expect(ensureGuestFile(file, root)).toBe('installed')
    expect(readFileSync(target(root), 'utf8')).toBe(file.content)
    expect(statSync(target(root)).mode & 0o7777).toBe(0o755)
    expect(ensureGuestFile(file, root)).toBe('unchanged')
  })

  it('replaces other content, a wrong mode and a symlink', () => {
    const root = mkdtempSync(join(TMP, 'root-'))
    mkdirSync(join(root, 'usr/local/bin'), { recursive: true })
    writeFileSync(target(root), '#!/bin/sh\necho v1\n', { mode: 0o755 })
    expect(ensureGuestFile(file, root)).toBe('updated')
    expect(readFileSync(target(root), 'utf8')).toBe(file.content)

    chmodSync(target(root), 0o644)
    expect(ensureGuestFile(file, root)).toBe('updated')
    expect(statSync(target(root)).mode & 0o7777).toBe(0o755)

    rmSync(target(root))
    writeFileSync(join(root, 'elsewhere'), 'other')
    symlinkSync(join(root, 'elsewhere'), target(root))
    expect(ensureGuestFile(file, root)).toBe('updated')
    expect(readFileSync(join(root, 'elsewhere'), 'utf8')).toBe('other')
    expect(readFileSync(target(root), 'utf8')).toBe(file.content)
  })
})

/** The wrapper with its lib dir moved to a temp dir, `id` and `exec` stubbed: prints the argv it would exec. */
function runCli(name: 'claude' | 'codex', user: string, args: string[], env: Record<string, string> = {}) {
  const lib = mkdtempSync(join(TMP, 'lib-'))
  writeFileSync(join(lib, `${name}-real`), '')
  const script = CLI_WRAPPER.replaceAll('/usr/local/lib/milibot', lib)
  const prelude = `id() { echo ${user}; }\nexec() { printf '%s\\n' "$@"; exit 0; }\n`
  const out = execFileSync('bash', ['-c', prelude + script, `/usr/local/bin/${name}`, ...args], {
    cwd: '/',
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', ...env },
    encoding: 'utf8',
  })
  return { argv: out.split('\n').slice(0, -1), real: join(lib, `${name}-real`) }
}

describe('CLI wrapper (claude, codex)', () => {
  it('runs the real binary directly for agent (the daemon never goes through sudo)', () => {
    const { argv, real } = runCli('claude', 'agent', ['-p', '--verbose', 'a b'])
    expect(argv).toEqual([real, '-p', '--verbose', 'a b'])
  })

  it('switches any other user to agent, keeping the display, browser and working directory', () => {
    const { argv, real } = runCli('claude', 'bot-lead', ['auth', 'login'], {
      DISPLAY: ':1',
      BROWSER: 'milibot-browser',
      TERM: 'xterm',
    })
    expect(argv.slice(0, 7)).toEqual(['sudo', '-n', '-u', 'agent', '-H', '--', '/usr/bin/env'])
    expect(argv).toContain('DISPLAY=:1')
    expect(argv).toContain('BROWSER=milibot-browser')
    expect(argv).toContain('TERM=xterm')
    expect(argv.some((a) => a.startsWith('XAUTHORITY=') || a.startsWith('CODEX_HOME='))).toBe(false)
    const shell = argv.indexOf('/bin/bash')
    expect(argv[shell + 1]).toBe('-lc')
    expect(argv.slice(shell + 3)).toEqual([real, '/', 'claude', 'auth', 'login'])
  })

  it("gives codex agent's CODEX_HOME for every user", () => {
    const { argv, real } = runCli('codex', 'bot-lead', ['login'])
    expect(argv).toContain('CODEX_HOME=/home/agent/.codex')
    expect(argv.slice(argv.indexOf('/bin/bash') + 3)).toEqual([real, '/', 'codex', 'login'])
    const direct = spawnSync(
      'bash',
      ['-c', `exec() { echo "$CODEX_HOME"; exit 0; }\nid() { echo agent; }\n${runnable('codex')}`, 'codex'],
      { encoding: 'utf8' },
    )
    expect(direct.stdout.trim()).toBe('/home/agent/.codex')
  })

  it('starts in the caller directory when agent can enter it, else in /workspace', () => {
    const { argv } = runCli('claude', 'bot-lead', [])
    const inner = argv[argv.indexOf('/bin/bash') + 2]!
    const run = (dir: string) =>
      execFileSync('bash', ['-c', inner.replaceAll('/workspace', '/tmp'), 'pwd', dir, 'claude'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim()
    expect(run('/')).toBe('/')
    expect(run('/nonexistent-dir')).toBe('/tmp')
  })

  it('says so when the CLI is not installed', () => {
    const missing = CLI_WRAPPER.replaceAll('/usr/local/lib/milibot', join(TMP, 'nowhere'))
    const result = spawnSync('bash', ['-c', missing, '/usr/local/bin/codex'], { encoding: 'utf8' })
    expect(result.status).toBe(127)
    expect(result.stderr.trim()).toBe('codex is not installed in this VM')
  })
})

/** The wrapper for `name` with an existing real binary, as a script body. */
function runnable(name: string): string {
  const lib = mkdtempSync(join(TMP, 'lib-'))
  writeFileSync(join(lib, `${name}-real`), '')
  return CLI_WRAPPER.replaceAll('/usr/local/lib/milibot', lib)
}

describe('gh wrapper', () => {
  const wrapper = source('gh')
  const policyFile = join(TMP, 'git-policy')
  const testable = wrapper.replace('policy=/etc/milibot/git-policy', `policy=${policyFile}`)
  const fakeGh = `exec() { shift; printf 'gh'; printf ' %s' "$@"; echo; exit 0; }\n`

  function gh(args: string[], policy: string, options: { cwd?: string; env?: Record<string, string> } = {}) {
    writeFileSync(policyFile, policy)
    const result = spawnSync('bash', ['-c', fakeGh + testable, 'gh', ...args], {
      cwd: options.cwd ?? '/',
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', ...options.env },
      encoding: 'utf8',
    })
    return { status: result.status, stdout: result.stdout.trim(), stderr: result.stderr.trim() }
  }

  const policy = (draft: 0 | 1, merge: 0 | 1, dirs: string[] = []) =>
    [`DRAFT_PRS=${draft}`, `AUTO_MERGE=${merge}`, ...dirs.map((d) => `ALLOW_MERGE_DIR=${d}`), ''].join('\n')

  it('opens pull requests as drafts when the workspace asks for them', () => {
    expect(gh(['pr', 'create', '--title', 'x'], policy(1, 0)).stdout).toBe('gh pr create --title x --draft')
    expect(gh(['pr', 'create', '-d', '--title', 'x'], policy(1, 0)).stdout).toBe('gh pr create -d --title x')
    expect(gh(['pr', 'create', '--web'], policy(1, 0)).stdout).toBe('gh pr create --web')
    expect(gh(['pr', 'create', '--title', 'x'], policy(0, 0)).stdout).toBe('gh pr create --title x')
    expect(gh(['pr', 'list'], policy(1, 0)).stdout).toBe('gh pr list')
  })

  it('refuses to merge unless the workspace, the session folder or the lane allows it', () => {
    const refused = gh(['pr', 'merge', '7', '--squash'], policy(1, 0))
    expect(refused.status).toBe(1)
    expect(refused.stdout).toBe('')
    expect(refused.stderr).toBe(
      'Merging pull requests is disabled in this workspace: report the PR link and let the user merge it.',
    )
    expect(gh(['pr', 'merge', '7'], policy(1, 1)).stdout).toBe('gh pr merge 7')
    expect(gh(['pr', 'merge', '7'], policy(1, 0), { env: { MILIBOT_ALLOW_MERGE: '1' } }).stdout).toBe(
      'gh pr merge 7',
    )
    expect(gh(['pr', 'merge', '7'], policy(1, 0, ['/workspace/x']), { cwd: '/usr/bin' }).status).toBe(1)
  })

  it('lets a merge through inside a folder the policy allows', () => {
    expect(gh(['pr', 'merge', '7'], policy(1, 0, ['/usr']), { cwd: '/usr/bin' }).stdout).toBe('gh pr merge 7')
    expect(gh(['pr', 'merge', '7'], policy(1, 0, ['/usr']), { cwd: '/' }).status).toBe(1)
    expect(gh(['pr', 'merge', '7'], policy(1, 0, ['/us']), { cwd: '/usr' }).status).toBe(1)
  })

  it('defaults to drafts and no merges without a policy file', () => {
    const noPolicy = wrapper.replace('policy=/etc/milibot/git-policy', 'policy=/nonexistent/git-policy')
    const run = (args: string[]) =>
      spawnSync('bash', ['-c', fakeGh + noPolicy, 'gh', ...args], { cwd: '/', encoding: 'utf8' })
    expect(run(['pr', 'create']).stdout.trim()).toBe('gh pr create --draft')
    expect(run(['pr', 'merge', '1']).status).toBe(1)
  })
})

describe('Chrome launcher', () => {
  const run = (display: string) =>
    execFileSync('sh', [new URL('milibot-browser', BIN).pathname, '--restore-last-session'], {
      env: { PATH: process.env.PATH, HOME: '/home/bot-iris', DISPLAY: display, MILIBOT_BROWSER_BIN: 'echo' },
      encoding: 'utf8',
    }).trim()

  it('opens the bot profile with a DevTools port of CDP_PORT_BASE + display, passing extra flags through', () => {
    const argv = run(':3').split(' ')
    expect(argv).toContain('--user-data-dir=/home/bot-iris/.config/milibot-browser')
    expect(argv).toContain(`--remote-debugging-port=${CDP_PORT_BASE + 3}`)
    expect(argv.at(-1)).toBe('--restore-last-session')
    expect(run(':12.0')).toContain(`--remote-debugging-port=${CDP_PORT_BASE + 12}`)
  })
})
