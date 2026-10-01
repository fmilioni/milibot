import { describe, expect, it } from 'vitest'

import { lineDiff } from '../core/diff'
import { clipPatch, MAX_STEP_PATCH_BYTES, patchFromHunks, unifiedPatch } from './file-edits'

const lines = (n: number, prefix = 'line') => Array.from({ length: n }, (_, i) => `${prefix} ${i + 1}`)

describe('unifiedPatch', () => {
  it('writes hunks with real line numbers and three lines of context', () => {
    const before = lines(20).join('\n') + '\n'
    const after = lines(20)
      .map((l) => (l === 'line 10' ? 'line ten' : l))
      .join('\n')
      .concat('\n')
    const { patch, additions, deletions } = unifiedPatch(before, after)
    expect(patch).toBe(
      [
        '@@ -7,7 +7,7 @@',
        ' line 7',
        ' line 8',
        ' line 9',
        '-line 10',
        '+line ten',
        ' line 11',
        ' line 12',
        ' line 13',
      ].join('\n'),
    )
    expect([additions, deletions]).toEqual([1, 1])
  })

  it('splits distant changes into separate hunks and merges near ones', () => {
    const before = lines(30)
    const after = [...before]
    after[1] = 'x'
    after[25] = 'y'
    const far = unifiedPatch(before.join('\n'), after.join('\n')).patch
    expect(far.split('\n').filter((l) => l.startsWith('@@'))).toEqual([
      '@@ -1,5 +1,5 @@',
      '@@ -23,7 +23,7 @@',
    ])
    const near = [...before]
    near[1] = 'x'
    near[7] = 'y'
    expect(unifiedPatch(before.join('\n'), near.join('\n')).patch.split('\n')[0]).toBe('@@ -1,11 +1,11 @@')
  })

  it('handles new and emptied files', () => {
    expect(unifiedPatch('', 'a\nb\n')).toEqual({
      patch: '@@ -0,0 +1,2 @@\n+a\n+b',
      additions: 2,
      deletions: 0,
    })
    expect(unifiedPatch('a\n', '')).toEqual({ patch: '@@ -1,1 +0,0 @@\n-a', additions: 0, deletions: 1 })
    expect(unifiedPatch('same\n', 'same\n').patch).toBe('')
  })

  it('stays line-accurate for a small edit in a long file', () => {
    const before = lines(5000)
    const after = [...before]
    after[4000] = 'changed'
    const { patch, additions, deletions } = unifiedPatch(before.join('\n'), after.join('\n'))
    expect(patch.split('\n')[0]).toBe('@@ -3998,7 +3998,7 @@')
    expect([additions, deletions]).toEqual([1, 1])
  })

  it('leaves lineDiff as it was', () => {
    expect(lineDiff('a\nb\nc\nd\ne\nf\ng', 'a\nb\nc\nX\ne\nf\ng')).toEqual({
      diff: ['@@', ' b', ' c', '-d', '+X', ' e', ' f', '@@'].join('\n'),
      added: 1,
      removed: 1,
    })
  })
})

describe('patchFromHunks', () => {
  it('turns Claude Code structuredPatch hunks into unified text', () => {
    const result = patchFromHunks([
      { oldStart: 18, oldLines: 2, newStart: 18, newLines: 3, lines: ['  a', '+  b', '  c'] },
    ])
    expect(result).toEqual({ patch: '@@ -18,2 +18,3 @@\n  a\n+  b\n  c', additions: 1, deletions: 0 })
  })
})

describe('clipPatch', () => {
  it('cuts at a line boundary', () => {
    const patch = Array.from({ length: 50_000 }, () => '+0123456789').join('\n')
    const clipped = clipPatch(patch)
    expect(clipped.truncated).toBe(true)
    expect(clipped.patch.length).toBeLessThanOrEqual(MAX_STEP_PATCH_BYTES)
    expect(clipped.patch.endsWith('+0123456789')).toBe(true)
  })
})
