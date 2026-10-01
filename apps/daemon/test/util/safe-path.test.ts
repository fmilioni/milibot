import { posix, win32 } from 'node:path'

import { describe, expect, it } from 'vitest'

import { containedJoin, hostSafeName, sanitizeFileName } from '../../src/util/safe-path'

describe('safe paths', () => {
  it('keeps file names safe as one path segment', () => {
    expect(sanitizeFileName('../../etc/passwd')).toBe('passwd')
    expect(sanitizeFileName('C:\\Users\\a\\photo.png')).toBe('photo.png')
    expect(sanitizeFileName('...hidden')).toBe('hidden')
    expect(sanitizeFileName('a\u0000b\nc.txt')).toBe('abc.txt')
    expect(sanitizeFileName('what?.txt')).toBe('what_.txt')
    expect(sanitizeFileName('   ')).toBe('file')
    const long = sanitizeFileName(`${'x'.repeat(300)}.tar.gz`)
    expect(long.length).toBe(120)
    expect(long.endsWith('x.gz')).toBe(true)
  })

  it('makes names from the VM safe as host file names, Windows included', () => {
    const traversal = hostSafeName('..\\..\\..\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\x.bat')
    expect(traversal).toBe('x.bat')
    expect(win32.join('C:\\exports\\doc', traversal)).toBe('C:\\exports\\doc\\x.bat')
    expect(hostSafeName('report: q1.pdf')).toBe('report_ q1.pdf')
    expect(hostSafeName('a:b')).toBe('a_b')
    expect(hostSafeName('notes.txt. . ')).toBe('notes.txt')
    expect(hostSafeName('...')).toBe('file')
    expect(hostSafeName('CON.txt')).toBe('_CON.txt')
    expect(hostSafeName('nul')).toBe('_nul')
    expect(hostSafeName('com1.tar.gz')).toBe('_com1.tar.gz')
    expect(hostSafeName('console.log')).toBe('console.log')
    expect(hostSafeName('Final résumé.pdf')).toBe('Final résumé.pdf')
  })

  it('joins outside path segments only while they stay inside the root', () => {
    expect(containedJoin('/ws/skills', ['a', 'b.md'], posix)).toBe('/ws/skills/a/b.md')
    expect(containedJoin('C:\\ws\\skills', ['a', 'b.md'], win32)).toBe('C:\\ws\\skills\\a\\b.md')
    expect(containedJoin('/ws', ['..foo', 'x'], posix)).toBe('/ws/..foo/x')
    for (const pathImpl of [posix, win32]) {
      const root = pathImpl === win32 ? 'C:\\ws' : '/ws'
      for (const parts of [
        [],
        [''],
        ['.'],
        ['..', 'x'],
        ['a', '..'],
        ['..\\..\\x.bat'],
        ['a:b'],
        ['C:', 'x'],
        ['/etc', 'passwd'],
        ['a/../../x'],
      ])
        expect(containedJoin(root, parts, pathImpl)).toBeNull()
    }
  })
})
