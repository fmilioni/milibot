import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, describe, expect, it } from 'vitest'

import { HttpError } from '../src/errors.ts'
import { fsRead, fsWrite } from '../src/fsops.ts'
import type { PasswdEntry } from '../src/users.ts'

const ROOT = realpathSync(mkdtempSync(join(tmpdir(), 'milibot-fsops-')))
const OUTSIDE = realpathSync(mkdtempSync(join(tmpdir(), 'milibot-fsops-out-')))
afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true })
  rmSync(OUTSIDE, { recursive: true, force: true })
})

const me: PasswdEntry = {
  name: 'me',
  uid: process.getuid?.() ?? 0,
  gid: process.getgid?.() ?? 0,
  home: '/',
  shell: '/bin/sh',
}

async function errorCode(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
  } catch (err) {
    if (err instanceof HttpError) return err.code
    throw err
  }
  throw new Error('expected an error')
}

describe('fsWrite', () => {
  it('creates missing folders and the file, relative or absolute inside the root', async () => {
    const written = await fsWrite({ path: 'a/b/c.txt', content: 'hello' }, me, ROOT)
    expect(written).toMatchObject({ path: join(ROOT, 'a/b/c.txt'), type: 'file', size: 5, mode: '664' })
    expect(statSync(join(ROOT, 'a/b')).isDirectory()).toBe(true)
    await fsWrite({ path: join(ROOT, 'a/b/c.txt'), content: ' world', append: true }, me, ROOT)
    expect(readFileSync(join(ROOT, 'a/b/c.txt'), 'utf8')).toBe('hello world')
  })

  it('decodes base64 and applies an explicit mode to a new file', async () => {
    const written = await fsWrite(
      {
        path: 'bin.dat',
        content: Buffer.from([0, 1, 2]).toString('base64'),
        encoding: 'base64',
        mode: '0640',
      },
      me,
      ROOT,
    )
    expect(written).toMatchObject({ size: 3, mode: '640' })
  })

  it('refuses the root, paths outside it, symlinks out of it and bad input', async () => {
    symlinkSync(OUTSIDE, join(ROOT, 'escape'))
    expect(await errorCode(fsWrite({ path: ROOT, content: 'x' }, me, ROOT))).toBe('invalid_path')
    expect(await errorCode(fsWrite({ path: '../x', content: 'x' }, me, ROOT))).toBe('path_outside_workspace')
    expect(await errorCode(fsWrite({ path: 'escape/x', content: 'x' }, me, ROOT))).toBe(
      'path_outside_workspace',
    )
    expect(await errorCode(fsWrite({ path: 'y', content: 1 }, me, ROOT))).toBe('invalid_content')
    expect(await errorCode(fsWrite({ path: 'y', content: 'x', encoding: 'hex' }, me, ROOT))).toBe(
      'invalid_encoding',
    )
    mkdirSync(join(ROOT, 'dir'))
    expect(await errorCode(fsWrite({ path: 'dir', content: 'x' }, me, ROOT))).toBe('not_a_file')
  })
})

describe('fsRead', () => {
  it('reads whole files and chunks, telling when more is left', async () => {
    writeFileSync(join(ROOT, 'r.txt'), 'abcdefghij')
    expect(await fsRead({ path: 'r.txt' }, ROOT)).toMatchObject({
      size: 10,
      offset: 0,
      content: 'abcdefghij',
      truncated: false,
    })
    expect(await fsRead({ path: 'r.txt', offset: 2, maxBytes: 3 }, ROOT)).toMatchObject({
      content: 'cde',
      truncated: true,
    })
    expect((await fsRead({ path: 'r.txt', encoding: 'base64', maxBytes: 2 }, ROOT)).content).toBe(
      Buffer.from('ab').toString('base64'),
    )
  })

  it('reports missing paths, folders and escapes', async () => {
    expect(await errorCode(fsRead({ path: 'missing.txt' }, ROOT))).toBe('path_not_found')
    mkdirSync(join(ROOT, 'folder'))
    expect(await errorCode(fsRead({ path: 'folder' }, ROOT))).toBe('not_a_file')
    expect(await errorCode(fsRead({ path: '/etc/passwd' }, ROOT))).toBe('path_outside_workspace')
    expect(await errorCode(fsRead({}, ROOT))).toBe('invalid_path')
  })
})
