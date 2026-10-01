import type { Attachment } from '@milibot/shared'
import { describe, expect, it } from 'vitest'

import {
  attachmentKind,
  pastedFileName,
  sendableAttachmentIds,
  splitDesignFiles,
  toBase64,
  UploadCancelled,
  uploadFile,
} from './attachment-upload'

const attachment = (id: string, status: Attachment['status']): Attachment => ({
  id,
  conversationId: 'cnv',
  messageId: null,
  name: 'a',
  size: 1,
  mimeType: '',
  path: '/workspace/uploads/a',
  status,
  progress: 0,
  image: null,
  error: null,
  createdAt: 0,
})

describe('uploadFile', () => {
  it('sends the file in chunks, reports progress and completes', async () => {
    const bytes = new Uint8Array(Array.from({ length: 10 }, (_, i) => i))
    const file = Object.assign(new Blob([bytes], { type: 'text/plain' }), { name: 'data.txt' })
    const chunks: Array<[number, string]> = []
    const progress: number[] = []
    const result = await uploadFile(file, {
      chunkBytes: 4,
      create: async (body) => {
        expect(body).toEqual({ name: 'data.txt', size: 10, mimeType: 'text/plain' })
        return attachment('att_1', 'uploading')
      },
      chunk: async (_id, offset, data) => {
        chunks.push([offset, data])
        return { received: offset }
      },
      complete: async () => attachment('att_1', 'queued'),
      onProgress: (fraction) => progress.push(fraction),
    })
    expect(result.status).toBe('queued')
    expect(chunks.map(([offset]) => offset)).toEqual([0, 4, 8])
    expect(chunks.map(([, data]) => Array.from(atob(data), (c) => c.charCodeAt(0)))).toEqual([
      [0, 1, 2, 3],
      [4, 5, 6, 7],
      [8, 9],
    ])
    expect(progress).toEqual([0, 0.4, 0.8, 1])
  })

  it('stops when cancelled', async () => {
    const controller = new AbortController()
    const file = Object.assign(new Blob([new Uint8Array(8)]), { name: 'x' })
    await expect(
      uploadFile(file, {
        chunkBytes: 4,
        signal: controller.signal,
        create: async () => attachment('att_1', 'uploading'),
        chunk: async () => {
          controller.abort()
          return { received: 4 }
        },
        complete: async () => attachment('att_1', 'queued'),
      }),
    ).rejects.toBeInstanceOf(UploadCancelled)
  })
})

describe('attachment helpers', () => {
  it('encodes base64 like Buffer, also for large arrays', () => {
    const bytes = new Uint8Array(100_000).map((_, i) => i % 256)
    const decoded = atob(toBase64(bytes))
    expect(decoded.length).toBe(bytes.length)
    expect(Array.from(decoded.slice(250, 260), (c) => c.charCodeAt(0))).toEqual([
      250, 251, 252, 253, 254, 255, 0, 1, 2, 3,
    ])
    expect(toBase64(new Uint8Array([104, 105]))).toBe('aGk=')
  })

  it('picks the icon kind', () => {
    expect(attachmentKind('image/png', 'a.png')).toBe('image')
    expect(attachmentKind('', 'Report.PDF')).toBe('pdf')
    expect(attachmentKind('application/zip', 'x.zip')).toBe('archive')
    expect(attachmentKind('', 'notes.md')).toBe('text')
    expect(attachmentKind('application/octet-stream', 'bin')).toBe('file')
  })

  it('names pasted images', () => {
    expect(pastedFileName('image/png', new Date(2026, 8, 26, 9, 5, 3), 'Pasted image')).toBe(
      'Pasted image 2026-09-26 09.05.03.png',
    )
    expect(pastedFileName('image/jpeg', new Date(2026, 0, 1), 'Pasted image')).toMatch(/\.jpg$/)
  })

  it('sends only when every upload reached the daemon', () => {
    expect(sendableAttachmentIds([])).toEqual([])
    expect(sendableAttachmentIds([{ attachment: null, error: null }])).toBeNull()
    expect(sendableAttachmentIds([{ attachment: attachment('a', 'uploading'), error: null }])).toBeNull()
    expect(
      sendableAttachmentIds([
        { attachment: attachment('a', 'queued'), error: null },
        { attachment: attachment('b', 'ready'), error: null },
        { attachment: null, error: 'too_large' },
        { attachment: attachment('c', 'failed'), error: null },
      ]),
    ).toEqual(['a', 'b'])
  })

  it('sets .mbdesign files apart from attachments', () => {
    const files = [
      { name: 'Shop.mbdesign' },
      { name: 'photo.png' },
      { name: 'X.MBDESIGN' },
      { name: 'mbdesign' },
    ]
    expect(splitDesignFiles(files)).toEqual({
      designs: [{ name: 'Shop.mbdesign' }, { name: 'X.MBDESIGN' }],
      others: [{ name: 'photo.png' }, { name: 'mbdesign' }],
    })
  })
})
