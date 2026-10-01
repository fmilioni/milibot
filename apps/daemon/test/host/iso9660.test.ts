import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { buildIso } from '@milibot/shared/portable/iso9660'
import { describe, expect, it } from 'vitest'

import { findExecutable } from '../../src/host/executables'
import { removeDir, tempDir } from '../support/temp'

const text = (s: string) => new TextEncoder().encode(s)

describe('buildIso', () => {
  const files = [
    { name: 'user-data', data: text('#cloud-config\nusers: []\n') },
    { name: 'meta-data', data: text('instance-id: x\n') },
    { name: 'payload.tgz', data: new Uint8Array(5000).map((_, i) => i % 251) },
    { name: 'empty', data: new Uint8Array() },
  ]

  const xorriso = findExecutable('xorriso')
  it.skipIf(!xorriso)('is readable by xorriso', () => {
    const dir = tempDir('iso')
    try {
      const file = join(dir, 'seed.iso')
      writeFileSync(file, buildIso(files, { volumeId: 'cidata' }))
      const out = execFileSync(
        xorriso!,
        ['-indev', `stdio:${file}`, '-pvd_info', '-find', '/', '-type', 'f'],
        {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      )
      expect(out).toContain("'/user-data'")
      expect(out).toContain("'/payload.tgz'")
      execFileSync(
        xorriso!,
        ['-osirrox', 'on', '-indev', `stdio:${file}`, '-extract', '/user-data', join(dir, 'ud')],
        {
          stdio: 'ignore',
        },
      )
      const extracted = readFileSync(join(dir, 'ud'), 'utf8')
      expect(extracted).toBe('#cloud-config\nusers: []\n')
    } finally {
      removeDir(dir)
    }
  })
})
