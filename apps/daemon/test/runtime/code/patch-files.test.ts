import { describe, expect, it } from 'vitest'

import { splitPatchByFile } from '../../../src/runtime/code/patch-files'

describe('splitPatchByFile', () => {
  it('splits a git patch into files with status and counts', () => {
    const patch = [
      'diff --git a/src/a.ts b/src/a.ts',
      'index 1..2 100644',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1,2 +1,2 @@',
      '-old',
      '+new',
      ' same',
      'diff --git a/new.txt b/new.txt',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/new.txt',
      '@@ -0,0 +1,1 @@',
      '+hello',
      'diff --git a/gone.txt b/gone.txt',
      '--- a/gone.txt',
      '+++ /dev/null',
      '@@ -1 +0,0 @@',
      '-bye',
      '',
    ].join('\n')
    expect(splitPatchByFile(patch)).toEqual([
      {
        path: 'src/a.ts',
        status: 'modified',
        additions: 1,
        deletions: 1,
        patch: '@@ -1,2 +1,2 @@\n-old\n+new\n same',
        truncated: false,
      },
      {
        path: 'new.txt',
        status: 'added',
        additions: 1,
        deletions: 0,
        patch: '@@ -0,0 +1,1 @@\n+hello',
        truncated: false,
      },
      {
        path: 'gone.txt',
        status: 'deleted',
        additions: 0,
        deletions: 1,
        patch: '@@ -1 +0,0 @@\n-bye',
        truncated: false,
      },
    ])
  })

  it('keeps paths of plain -p0 patches and does not split on removed "--" lines', () => {
    const patch = [
      '--- notes.md\t2026-01-01',
      '+++ notes.md\t2026-01-02',
      '@@ -1,2 +1,1 @@',
      '--- separator',
      ' keep',
      '--- other.md',
      '+++ other.md',
      '@@ -1 +1 @@',
      '-x',
      '+y',
    ].join('\n')
    const files = splitPatchByFile(patch)
    expect(files.map((f) => [f.path, f.additions, f.deletions])).toEqual([
      ['notes.md', 0, 1],
      ['other.md', 1, 1],
    ])
  })
})
