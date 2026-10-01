import { describe, expect, it } from 'vitest'

import { imageMediaType } from '../../../src/runtime/files/sniff'
import {
  changeTotals,
  diffstatLines,
  languageOf,
  parseBaseline,
  parseChanges,
  parseImageSides,
} from '../../../src/runtime/sessions/diff'

const Z = '\0'

describe('session diff parsing', () => {
  it('reads baseline lines', () => {
    expect(parseBaseline('MODE=git\nBASE=0123abcd4567\n')).toEqual({ mode: 'git', base: '0123abcd4567' })
    expect(parseBaseline('MODE=shadow\nBASE=4b825dc642cb6eb9a060e54bf8d69288fbee4904\n')).toMatchObject({
      mode: 'shadow',
    })
    expect(parseBaseline('ERROR=too_large\n')).toEqual({ error: 'too_large' })
    expect(parseBaseline('')).toEqual({ error: 'failed' })
    expect(parseBaseline('MODE=git\nBASE=not a sha\n')).toEqual({ error: 'failed' })
  })

  it('merges numstat and name-status with renames, binaries and odd paths', () => {
    const numstat = [
      `3\t1\tsrc/a.ts`,
      `0\t5\tgone.txt`,
      `2\t0\t`,
      'old name.md',
      'docs/new name.md',
      `-\t-\timg.png`,
      `4\t0\tnew\tfile.txt`,
      '',
    ].join(Z)
    const nameStatus = [
      'M',
      'src/a.ts',
      'D',
      'gone.txt',
      'R087',
      'old name.md',
      'docs/new name.md',
      'M',
      'img.png',
      'A',
      'new\tfile.txt',
      '',
    ].join(Z)
    const files = parseChanges(`${numstat}${Z}@@${Z}${nameStatus}`)
    expect(files).toEqual([
      { path: 'src/a.ts', status: 'modified', additions: 3, deletions: 1, binary: false },
      { path: 'gone.txt', status: 'deleted', additions: 0, deletions: 5, binary: false },
      {
        path: 'docs/new name.md',
        oldPath: 'old name.md',
        status: 'renamed',
        additions: 2,
        deletions: 0,
        binary: false,
      },
      { path: 'img.png', status: 'modified', additions: 0, deletions: 0, binary: true },
      { path: 'new\tfile.txt', status: 'added', additions: 4, deletions: 0, binary: false },
    ])
    expect(changeTotals(files)).toEqual({ files: 5, additions: 9, deletions: 6 })
  })

  it('reads an empty diff and refuses unexpected output', () => {
    expect(parseChanges(`${Z}@@${Z}`)).toEqual([])
    expect(() => parseChanges('fatal: not a git repository')).toThrow()
  })

  it('lists changes for the bot, capped', () => {
    const files = Array.from({ length: 3 }, (_, i) => ({
      path: `f${i}.ts`,
      status: 'modified' as const,
      additions: i,
      deletions: 1,
      binary: false,
    }))
    expect(diffstatLines(files, 2)).toEqual(['f0.ts +0 −1', 'f1.ts +1 −1', '… and 1 more files'])
    expect(
      diffstatLines([{ path: 'b.png', status: 'added', additions: 0, deletions: 0, binary: true }]),
    ).toEqual(['b.png (binary, added)'])
  })

  it('knows the language of common files', () => {
    expect(languageOf('src/app.tsx')).toBe('tsx')
    expect(languageOf('Dockerfile')).toBe('docker')
    expect(languageOf('main.py')).toBe('python')
    expect(languageOf('LICENSE')).toBeUndefined()
  })
})

describe('session images', () => {
  it('reads both sides, a side too large to preview and a missing side', () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])
    const sides = parseImageSides(`BEFORE 7 ${png.toString('base64')}\nAFTER 9000000 -\n`)
    expect(sides.before).toEqual({ bytes: 7, data: png })
    expect(sides.after).toEqual({ bytes: 9000000, data: null })
    expect(parseImageSides('AFTER 0 \n')).toEqual({
      before: null,
      after: { bytes: 0, data: Buffer.alloc(0) },
    })
    expect(parseImageSides('')).toEqual({ before: null, after: null })
  })

  it('tells the image type from the first bytes', () => {
    expect(imageMediaType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d]))).toBe('image/png')
    expect(imageMediaType(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg')
    expect(imageMediaType(Buffer.from('RIFF\0\0\0\0WEBPVP8 ', 'latin1'))).toBe('image/webp')
    expect(imageMediaType(Buffer.from('\0\0\0\x1cftypavif', 'latin1'))).toBe('image/avif')
    expect(imageMediaType(Buffer.from('<svg'))).toBeNull()
  })
})
