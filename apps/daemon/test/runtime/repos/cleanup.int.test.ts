import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { type CleanupCandidate, cleanupInput, parseCleanupOutput } from '../../../src/runtime/repos/cleanup'
import { CHECKOUT_SCRIPT } from '../../../src/runtime/repos/scripts/checkout.generated'
import { CLEANUP_SCRIPT } from '../../../src/runtime/repos/scripts/cleanup.generated'
import { removeDir, tempDir } from '../../support/temp'

let root: string

function run(cmd: string, cwd = root, env: Record<string, string> = {}, input?: string) {
  const result = spawnSync('bash', ['-c', cmd], {
    cwd,
    input,
    env: {
      PATH: process.env.PATH ?? '',
      HOME: join(root, 'home'),
      LANG: 'C',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0',
      ...env,
    },
    encoding: 'utf8',
  })
  if (result.status !== 0) throw new Error(`${cmd}: ${result.stderr}`)
  return result.stdout
}

const inVm = (script: string) => script.replaceAll('/workspace', join(root, 'workspace'))
const clone = () => join(root, 'workspace/repos/app')
const wt = (name: string) => join(root, 'workspace/worktrees/app', name)

/** A worktree made like a session's: the checkout script at a path of its own. */
function worktree(name: string, branch = `bot/ana/${name}`): string {
  run(inVm(CHECKOUT_SCRIPT), root, {
    GIT_NAME: 'Ana',
    GIT_EMAIL: 'ana@milibot.local',
    REPO_URL: `file://${join(root, 'origin.git')}`,
    REPO_NAME: 'app',
    BOT_SLUG: 'ana',
    BRANCH: branch,
    BASE_BRANCH: '',
    WT_PATH: wt(name),
  })
  return wt(name)
}

function commit(dir: string, file: string) {
  writeFileSync(join(dir, file), file)
  run(`git add -A && git commit -qm ${file}`, dir)
}

function cleanup(candidates: Array<Partial<CleanupCandidate> & { path: string }>) {
  const stdout = run(
    inVm(CLEANUP_SCRIPT),
    root,
    { REPO_NAME: 'app', BASE_BRANCH: '' },
    cleanupInput(candidates.map((c) => ({ branch: '', prDone: false, ...c }))),
  )
  return parseCleanupOutput(stdout)
}

function only(candidate: Partial<CleanupCandidate> & { path: string }) {
  const { results } = cleanup([candidate])
  expect(results).toHaveLength(1)
  return results[0] as NonNullable<(typeof results)[number]>
}

const hasBranch = (branch: string) =>
  run(`git show-ref --verify --quiet refs/heads/${branch} && echo yes || echo no`, clone()).trim() === 'yes'

beforeEach(() => {
  root = tempDir('cleanup')
  mkdirSync(join(root, 'home'))
  const seed = join(root, 'seed')
  mkdirSync(seed)
  run(`git init -q --bare -b main ${join(root, 'origin.git')}`)
  run(
    `git init -q -b main && git config user.name Seed && git config user.email seed@x && ` +
      `git remote add origin ${join(root, 'origin.git')}`,
    seed,
  )
  writeFileSync(join(seed, '.gitignore'), 'node_modules/\n')
  commit(seed, 'first.txt')
  run('git push -q origin main', seed)
})

afterEach(() => removeDir(root))

describe('worktree cleanup script', () => {
  it('removes a clean worktree whose commits are pushed, keeping a branch whose pull request is still open', () => {
    const dir = worktree('done')
    commit(dir, 'work.txt')
    run('git push -q origin HEAD', dir)
    mkdirSync(join(dir, 'node_modules'))
    writeFileSync(join(dir, 'node_modules/dep.js'), 'ignored')

    expect(only({ path: dir, branch: 'bot/ana/done' })).toEqual({
      path: dir,
      outcome: 'removed',
      reason: null,
      branch: 'bot/ana/done',
      branchDeleted: false,
    })
    expect(existsSync(dir)).toBe(false)
    expect(hasBranch('bot/ana/done')).toBe(true)
  })

  it('deletes the branch too once its pull request is merged or closed', () => {
    const dir = worktree('merged')
    commit(dir, 'work.txt')
    run('git push -q origin HEAD', dir)

    expect(only({ path: dir, branch: 'bot/ana/merged', prDone: true })).toMatchObject({
      outcome: 'removed',
      branchDeleted: true,
    })
    expect(hasBranch('bot/ana/merged')).toBe(false)
  })

  it('keeps a worktree with a tracked change, an untracked file or a commit not pushed', () => {
    const changed = worktree('changed')
    writeFileSync(join(changed, 'first.txt'), 'edited')
    const untracked = worktree('untracked')
    writeFileSync(join(untracked, 'new.txt'), 'new')
    const unpushed = worktree('unpushed')
    commit(unpushed, 'local.txt')

    const { results } = cleanup([
      { path: changed, prDone: true },
      { path: untracked, prDone: true },
      { path: unpushed, prDone: true },
    ])
    expect(results.map((r) => [r.outcome, r.reason])).toEqual([
      ['kept', 'dirty'],
      ['kept', 'dirty'],
      ['kept', 'unpushed'],
    ])
    for (const dir of [changed, untracked, unpushed]) expect(existsSync(dir)).toBe(true)
  })

  it('counts commits in a pull request head as pushed after a squash merge deleted the branch', () => {
    const dir = worktree('squashed')
    commit(dir, 'work.txt')
    run('git push -q origin HEAD:refs/heads/bot/ana/squashed HEAD:refs/pull/7/head', dir)
    const seed = join(root, 'seed')
    run('git pull -q origin main', seed)
    commit(seed, 'work.txt')
    run('git push -q origin main && git push -q origin --delete bot/ana/squashed', seed)

    expect(only({ path: dir, branch: 'bot/ana/squashed', prDone: true })).toMatchObject({
      outcome: 'removed',
      branchDeleted: true,
    })
    expect(run("git for-each-ref --format='%(refname)' refs/milibot/pull/", clone()).trim()).toBe(
      'refs/milibot/pull/7',
    )
  })

  it('keeps a worktree whose remote branch was deleted when no pull request head has its commits', () => {
    const dir = worktree('deleted')
    commit(dir, 'work.txt')
    run('git push -q origin HEAD && git push -q origin --delete bot/ana/deleted', dir)

    expect(only({ path: dir, branch: 'bot/ana/deleted', prDone: true })).toMatchObject({
      outcome: 'kept',
      reason: 'unpushed',
    })
  })

  it('removes a review worktree on a detached pull request head and the empty branch it was made on', () => {
    const author = worktree('author')
    commit(author, 'feature.txt')
    run('git push -q origin HEAD:refs/heads/bot/ana/author HEAD:refs/pull/9/head', author)
    const review = worktree('review', 'bot/marco/review')
    run('git fetch -q origin refs/pull/9/head && git checkout -q --detach FETCH_HEAD', review)

    expect(only({ path: review, branch: 'bot/marco/review' })).toMatchObject({
      outcome: 'removed',
      branch: '',
      branchDeleted: false,
    })
    expect(hasBranch('bot/marco/review')).toBe(false)
    expect(hasBranch('bot/ana/author')).toBe(true)
  })

  it('reports the branch a worktree was renamed to', () => {
    const dir = worktree('renamed', 'bot/ana/first-name')
    run('git branch -m bot/ana/renamed && git push -q origin HEAD', dir)

    expect(only({ path: dir, branch: 'bot/ana/first-name' })).toMatchObject({
      outcome: 'removed',
      branch: 'bot/ana/renamed',
    })
  })

  it('keeps a worktree with a stash of its branch or a rebase going on', () => {
    const stashed = worktree('stashed')
    writeFileSync(join(stashed, 'first.txt'), 'later')
    run('git stash -q', stashed)
    const rebasing = worktree('rebasing')
    commit(rebasing, 'one.txt')
    run('git push -q origin HEAD', rebasing)
    run('git rebase -q -i HEAD~1', rebasing, { GIT_SEQUENCE_EDITOR: 'sed -i.bak 1s/^pick/edit/' })

    const { results } = cleanup([{ path: stashed }, { path: rebasing }])
    expect(results.map((r) => r.reason)).toEqual(['stash', 'in_progress'])
  })

  it('keeps everything when the fetch fails', () => {
    const dir = worktree('offline')
    run(`git remote set-url origin file://${join(root, 'missing.git')}`, clone())

    const output = cleanup([{ path: dir }])
    expect(output.fetchFailed).toBe(true)
    expect(output.results).toEqual([
      { path: dir, outcome: 'kept', reason: 'fetch_failed', branch: '', branchDeleted: false },
    ])
    expect(existsSync(dir)).toBe(true)
  })

  it('reports a folder already gone and never touches one outside the worktrees folder', () => {
    worktree('first')
    const outside = join(root, 'workspace/repos/app')
    const { results } = cleanup([{ path: wt('missing') }, { path: outside }, { path: `${wt('x')}/../../app` }])
    expect(results.map((r) => [r.outcome, r.reason])).toEqual([
      ['gone', null],
      ['kept', 'outside'],
      ['kept', 'outside'],
    ])
    expect(existsSync(outside)).toBe(true)
  })
})
