import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { ZipReader, ZipWriter } from '../../src/util/zip'
import { useTempDir } from '../support/temp'

const dir = useTempDir('zip')

async function* chunks(parts: Buffer[]) {
  for (const part of parts) yield new Uint8Array(part)
}

describe('zip', () => {
  it('writes buffers and streamed entries that unzip and our reader both accept', async () => {
    const path = join(dir(), 'a.zip')
    const big = Buffer.alloc(3 * 1024 * 1024)
    for (let i = 0; i < big.length; i++) big[i] = (i * 7) % 251
    const zip = await ZipWriter.create(path)
    await zip.addBuffer('manifest.json', JSON.stringify({ ok: true }))
    await zip.addBuffer('notes.json', 'x'.repeat(10_000), { deflate: true })
    let counted = 0
    await zip.addStream('db.bin', chunks([big.subarray(0, 1000), big.subarray(1000)]), {
      deflate: true,
      onBytes: (n) => (counted += n),
    })
    await zip.addStream('workspace.tar.gz', chunks([Buffer.from('tar-bytes'), Buffer.from('-more')]))
    await zip.finish()
    expect(counted).toBe(big.length)

    expect(() => execFileSync('/usr/bin/unzip', ['-tq', path])).not.toThrow()
    expect(execFileSync('/usr/bin/unzip', ['-p', path, 'workspace.tar.gz']).toString()).toBe('tar-bytes-more')

    const reader = await ZipReader.open(path)
    expect(reader.entries.map((e) => e.name)).toEqual([
      'manifest.json',
      'notes.json',
      'db.bin',
      'workspace.tar.gz',
    ])
    expect(JSON.parse((await reader.read('manifest.json')).toString())).toEqual({ ok: true })
    expect((await reader.read('notes.json')).toString()).toBe('x'.repeat(10_000))
    expect((await reader.read('db.bin')).equals(big)).toBe(true)
    expect(reader.entry('workspace.tar.gz')).toMatchObject({ size: 14, compressedSize: 14 })
  })

  it('reads archives made by the zip command', async () => {
    writeFileSync(join(dir(), 'manifest.json'), '{"format":"milibot-workspace-backup"}')
    writeFileSync(join(dir(), 'bots.json'), '[' + '{"a":1},'.repeat(500) + '{}]')
    execFileSync('/usr/bin/zip', ['-q', '-X', join(dir(), 'old.zip'), 'manifest.json', 'bots.json'], {
      cwd: dir(),
    })
    const reader = await ZipReader.open(join(dir(), 'old.zip'))
    expect(JSON.parse((await reader.read('manifest.json')).toString())).toEqual({
      format: 'milibot-workspace-backup',
    })
    expect(JSON.parse((await reader.read('bots.json')).toString())).toHaveLength(501)
  })

  it('rejects files that are not zips', async () => {
    writeFileSync(join(dir(), 'x.zip'), 'hello')
    await expect(ZipReader.open(join(dir(), 'x.zip'))).rejects.toThrow(/not a zip/)
  })
})
