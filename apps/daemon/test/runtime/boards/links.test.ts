import { describe, expect, it } from 'vitest'

import { linkTarget, type LinkTargets } from '../../../src/runtime/boards/links'

const targets: LinkTargets = {
  plan: () => [
    { id: 'pln_2', title: 'Statement import' },
    { id: 'pln_1', title: 'Statement import' },
    { id: 'pln_3', title: 'Statement export' },
  ],
  session: () => [{ id: 'ses_1', title: 'Import statements' }],
  design: () => [],
}

describe('card link targets', () => {
  it('finds plans, sessions and designs by id, exact title (newest first) or a unique part of it', () => {
    expect(linkTarget(targets, 'plan', 'pln_1')).toEqual({
      ref: 'pln_1',
      label: 'Statement import',
      url: null,
    })
    expect(linkTarget(targets, 'plan', ' statement IMPORT ')).toMatchObject({ ref: 'pln_2' })
    expect(linkTarget(targets, 'plan', 'export')).toMatchObject({ ref: 'pln_3' })
    expect(linkTarget(targets, 'plan', 'statement')).toEqual({ problem: 'There is no plan "statement".' })
    expect(linkTarget(targets, 'session', 'import')).toMatchObject({ ref: 'ses_1' })
    expect(linkTarget(targets, 'design', 'home')).toEqual({ problem: 'There is no design "home".' })
  })

  it('reads commits, pull requests and URLs', () => {
    expect(linkTarget(targets, 'commit', 'ABCDEF1234')).toEqual({
      ref: 'abcdef1234',
      label: 'abcdef1',
      url: null,
    })
    expect(linkTarget(targets, 'commit', 'https://github.com/a/b/commit/abcdef1234')).toMatchObject({
      ref: 'abcdef1234',
      label: 'abcdef1',
    })
    expect(linkTarget(targets, 'commit', 'nope')).toHaveProperty('problem')
    expect(linkTarget(targets, 'pr', 'https://github.com/a/b/pull/7')).toMatchObject({ label: '#7' })
    expect(linkTarget(targets, 'url', 'ftp://x')).toEqual({ problem: '"ftp://x" is not a URL.' })
  })
})
