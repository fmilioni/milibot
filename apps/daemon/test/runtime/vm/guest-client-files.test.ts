import { describe, expect, it } from 'vitest'

import { GuestClient, GuestError } from '../../../src/runtime/vm/guest-client'

/** A client whose `/fs` and `/procs` calls hit an in-memory file and process list. */
function memoryClient(file: Buffer = Buffer.alloc(0)) {
  const client = new GuestClient('http://127.0.0.1:1', 'tok')
  const writes: Array<{ path: string; bytes: Buffer; append: boolean; owner?: string }> = []
  const signals: string[] = []
  client.fsReadChunk = async (path, offset, maxBytes) => {
    const part = file.subarray(offset, offset + maxBytes)
    return {
      path,
      size: file.length,
      content: part.toString('base64'),
      truncated: offset + part.length < file.length,
    }
  }
  client.fsWriteChunk = async (path, base64, options) => {
    writes.push({ path, bytes: Buffer.from(base64, 'base64'), ...options })
    return { path, size: 0 }
  }
  client.listProcs = async () => ({
    procs: [
      { id: 'p1', label: 'browser:nina', running: true },
      { id: 'p2', label: 'browser:rui', running: false },
      { id: 'p3', label: 'design:render', running: true },
      { id: 'p4', running: true },
      { id: 'p5', label: 'browser:ana', running: true },
    ],
  })
  client.procSignal = async (id, signal) => {
    signals.push(`${id} ${signal}`)
    if (id === 'p5') throw new GuestError('proc_gone', 'gone', 404)
    return { ok: true }
  }
  return { client, writes, signals }
}

describe('GuestClient whole-file helpers', () => {
  it('reads a file in chunks, or streams them', async () => {
    const data = Buffer.from('0123456789abcdef')
    const { client } = memoryClient(data)
    expect(await client.fsReadAll('/workspace/a.bin', { chunkBytes: 5 })).toEqual(data)
    const streamed: string[] = []
    const result = await client.fsReadAll('/workspace/a.bin', {
      chunkBytes: 6,
      onChunk: (bytes, offset) => {
        streamed.push(`${offset}:${bytes.toString()}`)
      },
    })
    expect(result.length).toBe(0)
    expect(streamed).toEqual(['0:012345', '6:6789ab', '12:cdef'])
    expect(await memoryClient().client.fsReadAll('/workspace/empty')).toEqual(Buffer.alloc(0))
  })

  it('refuses a file above maxBytes', async () => {
    const { client } = memoryClient(Buffer.alloc(20))
    await expect(client.fsReadAll('/workspace/big', { maxBytes: 10 })).rejects.toMatchObject({
      code: 'file_too_large',
    })
    await expect(
      client.fsReadAll('/workspace/big', { maxBytes: 10, tooLarge: (size) => new Error(`size ${size}`) }),
    ).rejects.toThrow('size 20')
  })

  it('writes in appended chunks, an empty file for no bytes', async () => {
    const { client, writes } = memoryClient()
    await client.fsWriteAll('/workspace/out.txt', 'hello world', { owner: 'bot-nina', chunkBytes: 4 })
    expect(writes.map((w) => [w.bytes.toString(), w.append, w.owner])).toEqual([
      ['hell', false, 'bot-nina'],
      ['o wo', true, 'bot-nina'],
      ['rld', true, 'bot-nina'],
    ])
    writes.length = 0
    await client.fsWriteAll('/workspace/empty.txt', new Uint8Array())
    expect(writes).toEqual([{ path: '/workspace/empty.txt', bytes: Buffer.alloc(0), append: false }])
  })

  it('signals the running processes of a label prefix', async () => {
    const { client, signals } = memoryClient()
    expect(await client.killProcs('browser:')).toBe(2)
    expect(signals).toEqual(['p1 SIGTERM', 'p5 SIGTERM'])
  })
})
