import { describe, expect, it } from 'vitest'

import {
  detectPrCommand,
  parseGhPrView,
  shellWords,
  statusAfter,
  statusOfPr,
} from '../../../src/runtime/tasks/pr-detect'

describe('shellWords', () => {
  it('honours quotes and stops at the end of the command', () => {
    expect(shellWords(` --title "Fix: login (retry)" --body 'a && b' && echo done`)).toEqual([
      '--title',
      'Fix: login (retry)',
      '--body',
      'a && b',
    ])
    expect(shellWords(' 12 --squash; git pull')).toEqual(['12', '--squash'])
  })
})

describe('detectPrCommand', () => {
  it('reads gh pr create: title, head, draft and the URL gh prints', () => {
    const command =
      'cd /workspace/worktrees/app/nina && git push -u origin HEAD && gh pr create --title "Corrige login" --body "$(cat <<\'EOF\'\nResumo\nEOF\n)" --head bot/nina/login'
    const output = 'Enumerating objects...\nhttps://github.com/acme/app/pull/42\n'
    expect(detectPrCommand(command, output)).toEqual({
      action: 'create',
      url: 'https://github.com/acme/app/pull/42',
      repo: 'acme/app',
      number: 42,
      title: 'Corrige login',
      branch: 'bot/nina/login',
      draft: false,
      auto: false,
    })
    expect(statusAfter(detectPrCommand(command, output)!)).toBe('review')
    const draft = detectPrCommand('gh pr create -d -t=x --fill', 'https://github.com/acme/app/pull/7')
    expect(draft?.draft).toBe(true)
    expect(statusAfter(draft!)).toBe('open')
  })

  it('reads gh pr merge by number, URL or branch', () => {
    const byNumber = detectPrCommand(
      'gh pr merge 42 --squash --delete-branch',
      '✓ Squashed and merged pull request acme/app#42 (Corrige login)',
    )
    expect(byNumber).toMatchObject({ action: 'merge', number: 42, url: null, repo: 'acme/app' })
    expect(statusAfter(byNumber!)).toBe('done')
    const byUrl = detectPrCommand('gh pr merge https://github.com/acme/app/pull/9 --auto --squash', '')
    expect(byUrl).toMatchObject({
      url: 'https://github.com/acme/app/pull/9',
      repo: 'acme/app',
      number: 9,
      auto: true,
    })
    expect(statusAfter(byUrl!)).toBe('review')
    const byRepo = detectPrCommand('gh pr merge 5 -R acme/api --merge', '')
    expect(byRepo).toMatchObject({ repo: 'acme/api', number: 5 })
    const current = detectPrCommand('gh pr merge --squash', '✓ Merged pull request #11 (Algo)')
    expect(current).toMatchObject({ number: 11, url: null })
  })

  it('reads ready/close/reopen', () => {
    expect(statusAfter(detectPrCommand('gh pr ready 3', '')!)).toBe('review')
    expect(statusAfter(detectPrCommand('gh pr close 3 --comment "obsoleto"', '')!)).toBe('failed')
    expect(detectPrCommand('gh pr reopen 3', '')?.action).toBe('reopen')
  })

  it('ignores other commands and failures that name no PR', () => {
    expect(detectPrCommand('gh pr list', 'https://github.com/acme/app/pull/1')).toBeNull()
    expect(detectPrCommand('gh pr view 3', '')).toBeNull()
    expect(detectPrCommand('echo gh-pr-create', '')).toBeNull()
    expect(detectPrCommand('gh pr create --title x', 'no commits between main and bot/x', true)).toBeNull()
    expect(
      detectPrCommand('gh pr create --fill', 'pull request create failed: GraphQL error', false),
    ).toBeNull()
  })

  it('keeps the existing PR when create says it already exists', () => {
    const output =
      'a pull request for branch "bot/nina/login" into branch "main" already exists:\nhttps://github.com/acme/app/pull/42'
    expect(detectPrCommand('gh pr create --fill', output, true)).toMatchObject({
      number: 42,
      action: 'create',
    })
  })
})

describe('gh pr view', () => {
  it('parses the JSON and maps the state to a card status', () => {
    const view = parseGhPrView(
      JSON.stringify({
        number: 4,
        title: 'T',
        url: 'https://github.com/a/b/pull/4',
        state: 'MERGED',
        isDraft: false,
        headRefName: 'x',
      }),
    )
    expect(view && statusOfPr(view)).toBe('done')
    expect(statusOfPr({ ...view!, state: 'OPEN', isDraft: true })).toBe('open')
    expect(statusOfPr({ ...view!, state: 'OPEN' })).toBe('review')
    expect(statusOfPr({ ...view!, state: 'CLOSED' })).toBe('failed')
    expect(parseGhPrView('not json')).toBeNull()
    expect(parseGhPrView('{}')).toBeNull()
  })
})
