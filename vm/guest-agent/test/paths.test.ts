import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { resolveInside, resolveWorkspacePath } from '../src/paths.ts'

describe('resolveInside', () => {
  it('resolves relative and absolute paths inside the root', () => {
    expect(resolveInside('/workspace', 'a/b.txt')).toBe('/workspace/a/b.txt')
    expect(resolveInside('/workspace', '/workspace/a')).toBe('/workspace/a')
    expect(resolveInside('/workspace', '.')).toBe('/workspace')
    expect(resolveInside('/workspace', 'a/../b')).toBe('/workspace/b')
  })

  it('rejects traversal and lookalike prefixes', () => {
    for (const bad of [
      '..',
      '../etc/passwd',
      '/etc/passwd',
      '/workspace/../etc',
      '/workspace2/x',
      'a/../../x',
    ]) {
      expect(() => resolveInside('/workspace', bad)).toThrow(/escapes/)
    }
  })

  it('rejects empty, non-string and NUL paths', () => {
    expect(() => resolveInside('/workspace', '')).toThrow()
    expect(() => resolveInside('/workspace', 42)).toThrow()
    expect(() => resolveInside('/workspace', 'a\0b')).toThrow(/NUL/)
  })
})

describe('resolveWorkspacePath (symlinks)', () => {
  const base = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'ga-paths-')))
  const root = path.join(base, 'ws')
  const outside = path.join(base, 'outside')
  mkdirSync(root)
  mkdirSync(outside)
  writeFileSync(path.join(outside, 'secret'), 'x')
  mkdirSync(path.join(root, 'dir'))
  symlinkSync(outside, path.join(root, 'escape'))
  symlinkSync(path.join(root, 'dir'), path.join(root, 'inner'))

  it('allows existing and not-yet-existing paths inside', () => {
    expect(resolveWorkspacePath('dir', root)).toBe(path.join(root, 'dir'))
    expect(resolveWorkspacePath('dir/new/file.txt', root)).toBe(path.join(root, 'dir/new/file.txt'))
    expect(resolveWorkspacePath('inner/x', root)).toBe(path.join(root, 'dir/x'))
  })

  it('rejects symlinks that point outside', () => {
    expect(() => resolveWorkspacePath('escape/secret', root)).toThrow(/symlink/)
    expect(() => resolveWorkspacePath('escape/new-file', root)).toThrow(/symlink/)
  })
})
