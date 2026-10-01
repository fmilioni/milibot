import { spawnSync } from 'node:child_process'

import { describe, expect, it } from 'vitest'

import { buildTar } from '../../src/util/tar'

describe('tar', () => {
  it('builds an archive tar lists with modes and long paths', () => {
    const long = `${'d'.repeat(90)}/${'f'.repeat(60)}.txt`
    const archive = buildTar([
      { path: 'a/SKILL.md', data: Buffer.from('hi'), mode: 0o644 },
      { path: 'a/run.sh', data: Buffer.from('#!/bin/sh\n'), mode: 0o755 },
      { path: long, data: Buffer.alloc(700, 1), mode: 0o644 },
    ])
    expect(archive.length % 512).toBe(0)
    const listed = spawnSync('tar', ['-tvf', '-'], { input: archive, encoding: 'utf8' })
    expect(listed.status).toBe(0)
    expect(listed.stdout).toMatch(/-rw-r--r--.* a\/SKILL\.md/)
    expect(listed.stdout).toMatch(/-rwxr-xr-x.* a\/run\.sh/)
    expect(listed.stdout).toContain(long)
  })
})
