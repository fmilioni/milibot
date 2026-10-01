import { describe, expect, it } from 'vitest'

import { fromCodexPatch, PatchError, placeBareHunks } from '../../../src/runtime/code/patch-hunks'
import { stripAnsi } from '../../../src/runtime/tools-core'

const FILE = [
  'import x from "x"',
  '',
  'function a() {',
  '  return 1',
  '}',
  '',
  'function b() {',
  '  return 1',
  '}',
  '',
].join('\n')

function reader(files: Record<string, string>) {
  const asked: string[] = []
  const read = async (path: string) => {
    asked.push(path)
    return files[path] ?? null
  }
  return { asked, read }
}

describe('hunks without line ranges', () => {
  it('leaves patches with ranges alone without reading files', async () => {
    const { asked, read } = reader({})
    const patch = '--- a/f.ts\n+++ b/f.ts\n@@ -1,1 +1,1 @@\n-a\n+b\n'
    expect(await placeBareHunks(patch, read)).toBe(patch)
    expect(asked).toEqual([])
  })

  it('places each hunk by its lines, in order, and writes real ranges', async () => {
    const { asked, read } = reader({ 'src/f.ts': FILE })
    const patch = [
      '--- a/src/f.ts',
      '+++ b/src/f.ts',
      '@@',
      ' function a() {',
      '-  return 1',
      '+  return 2',
      '+  // two',
      '@@',
      ' function b() {',
      '-  return 1',
      '+  return 3',
      '',
    ].join('\n')
    expect(await placeBareHunks(patch, read)).toBe(
      [
        '--- a/src/f.ts',
        '+++ b/src/f.ts',
        '@@ -3,2 +3,3 @@',
        ' function a() {',
        '-  return 1',
        '+  return 2',
        '+  // two',
        '@@ -7,2 +8,2 @@',
        ' function b() {',
        '-  return 1',
        '+  return 3',
        '',
      ].join('\n'),
    )
    expect(asked).toEqual(['src/f.ts'])
  })

  it('refuses a hunk that is missing or matches more than once', async () => {
    const { read } = reader({ 'f.ts': FILE })
    const ambiguous = '--- a/f.ts\n+++ b/f.ts\n@@\n-  return 1\n+  return 2\n'
    await expect(placeBareHunks(ambiguous, read)).rejects.toThrow(
      'hunk 1 (f.ts): context matches more than once; add more context lines',
    )
    const missing = '--- a/f.ts\n+++ b/f.ts\n@@\n function a() {\n-  return 9\n+  return 2\n'
    await expect(placeBareHunks(missing, read)).rejects.toThrow('hunk 1 (f.ts): context not found')
    const outOfOrder = [
      '--- a/f.ts',
      '+++ b/f.ts',
      '@@',
      ' function b() {',
      '-  return 1',
      '+  return 3',
      '@@',
      ' function a() {',
      '-  return 1',
      '+  return 2',
    ].join('\n')
    await expect(placeBareHunks(outOfOrder, read)).rejects.toThrow(
      'hunk 2 (f.ts): context not found after the previous hunk',
    )
  })

  it('uses the anchor after @@ to pick between repeated lines', async () => {
    const { read } = reader({ 'f.ts': FILE })
    const patch = '--- a/f.ts\n+++ b/f.ts\n@@ function b() {\n-  return 1\n+  return 3\n'
    expect(await placeBareHunks(patch, read)).toContain('@@ -8,1 +8,1 @@\n-  return 1\n+  return 3')
  })

  it('tolerates trailing whitespace and blank context lines without their space', async () => {
    const { read } = reader({ 'f.ts': 'a  \n\nb\r\nc\n' })
    const patch = '--- a/f.ts\n+++ b/f.ts\n@@\n a\n\n-b\n+B\n c\n'
    expect(await placeBareHunks(patch, read)).toBe(
      '--- a/f.ts\n+++ b/f.ts\n@@ -1,4 +1,4 @@\n a  \n \n-b\r\n+B\n c\n',
    )
  })

  it('handles new files and names a missing file', async () => {
    const { read } = reader({})
    const created = '--- /dev/null\n+++ b/n.ts\n@@\n+one\n+two\n'
    expect(await placeBareHunks(created, read)).toBe(
      '--- /dev/null\n+++ b/n.ts\n@@ -0,0 +1,2 @@\n+one\n+two\n',
    )
    const err = await placeBareHunks('--- a/calc/src/p.ts\n+++ b/calc/src/p.ts\n@@\n-a\n+b\n', read).catch(
      (e: unknown) => e,
    )
    expect(err).toBeInstanceOf(PatchError)
    expect((err as PatchError).missingPath).toBe('calc/src/p.ts')
  })

  it('tries the path without its first folder first, like git apply -p1', async () => {
    const { asked, read } = reader({ 'src/f.ts': 'x\n' })
    await placeBareHunks('--- src/f.ts\n+++ src/f.ts\n@@\n-x\n+y\n', read)
    expect(asked).toEqual(['f.ts', 'src/f.ts'])
  })
})

describe('Codex patches', () => {
  it('become unified diffs whose hunks are then placed', async () => {
    const codex = [
      '*** Begin Patch',
      '*** Update File: f.ts',
      ' function b() {',
      '-  return 1',
      '+  return 3',
      '*** Add File: n.ts',
      '+hello',
      '*** Delete File: old.ts',
      '*** End Patch',
    ].join('\n')
    const unified = fromCodexPatch(codex)
    expect(unified).toBe(
      [
        '--- a/f.ts',
        '+++ b/f.ts',
        '@@',
        ' function b() {',
        '-  return 1',
        '+  return 3',
        '--- /dev/null',
        '+++ b/n.ts',
        '@@',
        '+hello',
        '--- a/old.ts',
        '+++ /dev/null',
        '@@',
      ].join('\n'),
    )
    const { read } = reader({ 'f.ts': FILE, 'old.ts': 'bye\nnow\n' })
    expect(await placeBareHunks(unified, read)).toBe(
      [
        '--- a/f.ts',
        '+++ b/f.ts',
        '@@ -7,2 +7,2 @@',
        ' function b() {',
        '-  return 1',
        '+  return 3',
        '--- /dev/null',
        '+++ b/n.ts',
        '@@ -0,0 +1,1 @@',
        '+hello',
        '--- a/old.ts',
        '+++ /dev/null',
        '@@ -1,2 +0,0 @@',
        '-bye',
        '-now',
      ].join('\n'),
    )
  })

  it('refuses moves and leaves other patches as they are', () => {
    expect(() =>
      fromCodexPatch('*** Begin Patch\n*** Update File: a\n*** Move to: b\n*** End Patch'),
    ).toThrow(PatchError)
    expect(fromCodexPatch('--- a/x\n+++ b/x\n')).toBe('--- a/x\n+++ b/x\n')
  })
})

describe('terminal escapes', () => {
  it('are stripped from command output', () => {
    const colored =
      '\x1b[32m✓\x1b[39m src/a.test.ts \x1b[2m(3 tests)\x1b[22m\n\x1b]8;;https://x.dev\x07link\x1b]8;;\x07\x1b[2K\x1b[1G done\x1b(B'
    expect(stripAnsi(colored)).toBe('✓ src/a.test.ts (3 tests)\nlink done')
    expect(stripAnsi('plain [32m text')).toBe('plain [32m text')
  })
})
