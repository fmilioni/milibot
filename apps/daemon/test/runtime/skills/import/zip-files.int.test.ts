import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { zipFiles } from '../../../../src/runtime/skills/import/scan'
import { ZipReader, ZipWriter } from '../../../../src/util/zip'
import { useTempDir } from '../../../support/temp'

const tempDir = useTempDir('zip-files')

describe('zipFiles', () => {
  it('never inflates an entry past the size it declares', async () => {
    const path = join(tempDir(), 'bomb.zip')
    const zip = await ZipWriter.create(path)
    await zip.addBuffer('big.txt', Buffer.alloc(4 * 1024 * 1024, 'a'), { deflate: true })
    await zip.finish()
    // Forge the central directory so the entry claims 10 bytes.
    const bytes = readFileSync(path)
    const central = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]))
    bytes.writeUInt32LE(10, central + 24)
    writeFileSync(path, bytes)

    const { files } = zipFiles(await ZipReader.open(path), false)
    expect(files).toEqual([expect.objectContaining({ path: 'big.txt', size: 10 })])
    await expect(files[0]?.read()).rejects.toThrow(/too large/)
  })
})
