import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { beforeEach, describe, expect, it } from 'vitest'

import { assertUploadComplete, writeChunkAt } from '../../../src/runtime/files/upload'
import { useTempDir } from '../../support/temp'

const chunk = (offset: number, text: string) => ({ offset, data: Buffer.from(text).toString('base64') })

describe('chunked upload staging', () => {
  const dir = useTempDir('upload')
  let file: string

  beforeEach(() => {
    file = join(dir(), 'staged')
  })

  it('appends chunks and accepts a complete file', async () => {
    let received = await writeChunkAt(file, 0, 6, chunk(0, 'abc'))
    received = await writeChunkAt(file, received, 6, chunk(3, 'def'))
    expect(received).toBe(6)
    await assertUploadComplete(file, received, 6)
    expect(await readFile(file, 'utf8')).toBe('abcdef')
  })

  it('rewinds to a repeated offset, dropping what came after it', async () => {
    const received = await writeChunkAt(file, 0, 6, chunk(0, 'abcd'))
    expect(await writeChunkAt(file, received, 6, chunk(2, 'XY'))).toBe(4)
    expect(await readFile(file, 'utf8')).toBe('abXY')
  })

  it('refuses a gap and bytes past the declared size', async () => {
    await expect(writeChunkAt(file, 0, 6, chunk(2, 'ab'))).rejects.toMatchObject({
      code: 'validation_failed',
      message: 'Expected offset 0',
      details: { received: 0 },
    })
    await expect(writeChunkAt(file, 0, 2, chunk(0, 'abc'))).rejects.toThrow(
      'More bytes than the declared size',
    )
  })

  it('reports a short upload and creates the file of an empty one', async () => {
    const received = await writeChunkAt(file, 0, 6, chunk(0, 'abc'))
    await expect(assertUploadComplete(file, received, 6)).rejects.toThrow('Received 3 of 6 bytes')
    const empty = join(dir(), 'empty')
    await assertUploadComplete(empty, 0, 0)
    expect(await readFile(empty, 'utf8')).toBe('')
  })
})
