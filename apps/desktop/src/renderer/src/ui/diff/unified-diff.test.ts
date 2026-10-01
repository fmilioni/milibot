import { describe, expect, it } from 'vitest'

import { parseUnifiedDiff, splitRows, splitRowsOf, unifiedRowsOf } from './unified-diff'

const PATCH = [
  'diff --git a/src/auth.ts b/src/auth.ts',
  'index 1111111..2222222 100644',
  '--- a/src/auth.ts',
  '+++ b/src/auth.ts',
  '@@ -1,4 +1,5 @@ export function login()',
  ' import { a } from "a"',
  '-const x = 1',
  '-const y = 2',
  '+const x = 10',
  '+const z = 3',
  '+const w = 4',
  ' ',
  ' export {}',
  '@@ -20 +21,0 @@',
  '-gone',
  '\\ No newline at end of file',
  '',
].join('\n')

describe('parseUnifiedDiff', () => {
  it('reads hunks with line numbers on each side', () => {
    const diff = parseUnifiedDiff(PATCH)
    expect(diff.additions).toBe(3)
    expect(diff.deletions).toBe(3)
    expect(diff.hunks).toHaveLength(2)
    const [first, second] = diff.hunks
    expect(first).toMatchObject({ oldStart: 1, oldLines: 4, newStart: 1, newLines: 5 })
    expect(first?.section).toBe('export function login()')
    expect(first?.lines.map((l) => [l.type, l.oldNo, l.newNo])).toEqual([
      ['context', 1, 1],
      ['del', 2, null],
      ['del', 3, null],
      ['add', null, 2],
      ['add', null, 3],
      ['add', null, 4],
      ['context', 4, 5],
      ['context', 5, 6],
    ])
    expect(second).toMatchObject({ oldStart: 20, oldLines: 1, newStart: 21, newLines: 0 })
    expect(second?.lines[0]).toMatchObject({ type: 'del', content: 'gone', noNewline: true })
  })

  it('pairs removed lines with the added lines that follow them', () => {
    const [first] = parseUnifiedDiff(PATCH).hunks
    const lines = first!.lines
    expect(lines[1]?.pair).toBe(lines[3])
    expect(lines[3]?.pair).toBe(lines[1])
    expect(lines[2]?.pair).toBe(lines[4])
    expect(lines[5]?.pair).toBeUndefined()
    expect(lines[0]?.pair).toBeUndefined()
  })

  it('ignores a patch without hunks (binary, empty)', () => {
    expect(parseUnifiedDiff('Binary files a/x.png and b/x.png differ\n').hunks).toEqual([])
    expect(parseUnifiedDiff('').hunks).toEqual([])
  })
})

describe('split view', () => {
  it('pairs removed and added lines of a change block', () => {
    const [hunk] = parseUnifiedDiff(PATCH).hunks
    const rows = splitRows(hunk!)
    expect(rows.map((r) => [r.left?.content ?? null, r.right?.content ?? null])).toEqual([
      ['import { a } from "a"', 'import { a } from "a"'],
      ['const x = 1', 'const x = 10'],
      ['const y = 2', 'const z = 3'],
      [null, 'const w = 4'],
      ['', ''],
      ['export {}', 'export {}'],
    ])
  })

  it('flattens hunks into rows with a header before each', () => {
    const diff = parseUnifiedDiff(PATCH)
    const unified = unifiedRowsOf(diff)
    expect(unified.filter((r) => r.kind === 'hunk')).toHaveLength(2)
    expect(unified).toHaveLength(2 + 9)
    expect(splitRowsOf(diff)[0]?.kind).toBe('hunk')
    expect(new Set(unified.map((r) => r.key)).size).toBe(unified.length)
  })
})
