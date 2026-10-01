import { describe, expect, it } from 'vitest'

import { duArgs, duInodesArgs, parseExcludes, tarCreateArgs, tarExtractArgs } from '../src/archive.ts'

describe('workspace archive', () => {
  it('builds tar and du commands with the excludes', () => {
    expect(tarCreateArgs(['node_modules', '.venv'])).toEqual([
      '-C',
      '/workspace',
      '--numeric-owner',
      '--acls',
      '--warning=no-file-changed',
      '--warning=no-file-removed',
      '--warning=no-file-shrank',
      '--exclude=node_modules',
      '--exclude=.venv',
      '-cf',
      '-',
      '.',
    ])
    expect(tarExtractArgs()).toEqual(['-C', '/workspace', '--numeric-owner', '--acls', '-xpf', '-'])
    expect(duArgs(['dist'])).toEqual(['-s', '-B1', '--apparent-size', '--exclude=dist', '/workspace'])
    expect(duInodesArgs(['dist'])).toEqual(['-s', '--inodes', '--exclude=dist', '/workspace'])
  })

  it('validates exclude patterns', () => {
    expect(parseExcludes(undefined)).toEqual([])
    expect(parseExcludes([' target '])).toEqual(['target'])
    expect(() => parseExcludes(['a\nb'])).toThrow()
    expect(() => parseExcludes('x')).toThrow()
  })
})
