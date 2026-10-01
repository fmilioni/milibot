import { describe, expect, it } from 'vitest'

import { globToRegex, grepLines, parseGlobOutput } from '../../../src/runtime/code/search'

const matches = (glob: string, path: string) => new RegExp(globToRegex(glob)).test(path)

describe('glob patterns', () => {
  it('matches names at any depth without a slash, and paths from the folder with one', () => {
    expect(matches('*.ts', 'a.ts')).toBe(true)
    expect(matches('*.ts', 'src/deep/a.ts')).toBe(true)
    expect(matches('*.ts', 'a.tsx')).toBe(false)
    expect(matches('src/*.ts', 'src/a.ts')).toBe(true)
    expect(matches('src/*.ts', 'src/x/a.ts')).toBe(false)
    expect(matches('src/**/*.ts', 'src/a.ts')).toBe(true)
    expect(matches('src/**/*.ts', 'src/x/y/a.ts')).toBe(true)
    expect(matches('**/*.test.ts', 'a.test.ts')).toBe(true)
    expect(matches('*.{ts,tsx}', 'app/view.tsx')).toBe(true)
    expect(matches('file?.md', 'file1.md')).toBe(true)
    expect(matches('[ab].txt', 'b.txt')).toBe(true)
    expect(matches('[!ab].txt', 'b.txt')).toBe(false)
    expect(matches('a+b.ts', 'a+b.ts')).toBe(true)
  })

  it('sorts listed files by change time, newest first', () => {
    expect(parseGlobOutput('10\ta.ts\n30\tb.ts\n20\tc.ts\n\n')).toEqual(['b.ts', 'c.ts', 'a.ts'])
    expect(grepLines('./a.ts:1:x\nb.ts:2:y\n')).toEqual(['a.ts:1:x', 'b.ts:2:y'])
  })
})
