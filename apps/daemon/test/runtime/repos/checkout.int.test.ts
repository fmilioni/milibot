import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { checkoutWarnings } from '../../../src/runtime/repos/checkout'
import { CHECKOUT_SCRIPT } from '../../../src/runtime/repos/scripts/checkout.generated'
import { removeDir, tempDir } from '../../support/temp'

let root: string

function run(cmd: string, cwd = root, env: Record<string, string> = {}) {
  const result = spawnSync('bash', ['-c', cmd], {
    cwd,
    env: {
      PATH: process.env.PATH ?? '',
      HOME: join(root, 'home'),
      LANG: 'C',
      GIT_CONFIG_NOSYSTEM: '1',
      ...env,
    },
    encoding: 'utf8',
  })
  if (result.status !== 0) throw new Error(`${cmd}: ${result.stderr}`)
  return result.stdout
}

/** The repo_checkout script with the VM's /workspace moved into the test folder. */
function checkout(): Record<string, string> {
  const stdout = run(CHECKOUT_SCRIPT.replaceAll('/workspace', join(root, 'workspace')), root, {
    GIT_NAME: 'Ana',
    GIT_EMAIL: 'ana@milibot.local',
    REPO_URL: `file://${join(root, 'origin.git')}`,
    REPO_NAME: 'app',
    BOT_SLUG: 'ana',
    BRANCH: 'bot/ana/work',
    BASE_BRANCH: '',
    GIT_TERMINAL_PROMPT: '0',
  })
  return Object.fromEntries(
    stdout
      .split('\n')
      .map((l) => /^([A-Z]+)=(.*)$/.exec(l.trim()))
      .filter((m): m is RegExpExecArray => m !== null)
      .map((m) => [m[1] as string, m[2] as string]),
  )
}

/** Someone else pushes a commit to origin/main. */
function upstreamCommit(name: string) {
  const seed = join(root, 'seed')
  writeFileSync(join(seed, `${name}.txt`), name)
  run(`git add -A && git commit -qm ${name} && git push -q origin main`, seed)
}

const head = (dir: string, ref = 'HEAD') => run(`git rev-parse ${ref}`, dir).trim()

beforeEach(() => {
  root = tempDir('checkout')
  mkdirSync(join(root, 'home'))
  const seed = join(root, 'seed')
  mkdirSync(seed)
  run(`git init -q --bare -b main ${join(root, 'origin.git')}`)
  run(
    `git init -q -b main && git config user.name Seed && git config user.email seed@x && ` +
      `git remote add origin ${join(root, 'origin.git')}`,
    seed,
  )
  upstreamCommit('first')
})

afterEach(() => removeDir(root))

describe('repo_checkout script', () => {
  it('brings a reused worktree and the shared clone up to date before the bot works', () => {
    expect(checkout()).toMatchObject({ STATUS: 'created', BASE: 'main', BRANCH: 'bot/ana/work' })
    upstreamCommit('second')

    const info = checkout()
    expect(info).toMatchObject({ STATUS: 'reused', BEHIND: '0' })
    const worktree = join(root, 'workspace/worktrees/app/ana')
    const clone = join(root, 'workspace/repos/app')
    expect(head(worktree)).toBe(head(join(root, 'seed')))
    expect(head(clone)).toBe(head(join(root, 'seed')))
    expect(checkoutWarnings(info, 'main')).toEqual([])
  })

  it('leaves a branch with commits of its own alone and says how far behind it is', () => {
    checkout()
    const worktree = join(root, 'workspace/worktrees/app/ana')
    writeFileSync(join(worktree, 'mine.txt'), 'mine')
    run('git add -A && git commit -qm mine', worktree)
    const mine = head(worktree)
    upstreamCommit('second')

    const info = checkout()
    expect(info).toMatchObject({ STATUS: 'reused', BEHIND: '1' })
    expect(head(worktree)).toBe(mine)
    expect(checkoutWarnings(info, 'main').join('\n')).toContain('1 commit(s) behind origin/main')
  })
})
