import type { DefaultAgentHost } from '@milibot/agent'
import type { CompletionRequest } from '@milibot/agent/llm'
import { solidPng } from '@milibot/agent/testing'
import type { Attachment, Message } from '@milibot/shared'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { bootRuntime, type RuntimeHarness, stopRuntimes } from '../../support/runtime-harness'
import { useTempDir } from '../../support/temp'

const dir = useTempDir('attachments')

describe('messages with attachments', () => {
  let h: RuntimeHarness
  let host: DefaultAgentHost
  let conversationId: string
  const requests: CompletionRequest[] = []

  afterEach(stopRuntimes)

  beforeEach(async () => {
    requests.length = 0
    h = await bootRuntime({
      dir: dir(),
      vm: false,
      script: (request) => {
        requests.push(request)
        return { text: 'I saw the file.' }
      },
    })
    ;({ host, dm: conversationId } = h)
  })

  const call: RuntimeHarness['call'] = (...args) => h.call(...args)

  it('gives the model the file paths and the images', async () => {
    const png = solidPng(20, 10, [0, 0, 255])
    const created = await call<Attachment>(
      'createAttachment',
      { conversationId },
      { name: 'screen.png', size: png.length },
    )
    await call(
      'uploadAttachmentChunk',
      { attachmentId: created.id },
      { offset: 0, data: Buffer.from(png).toString('base64') },
    )
    const completed = await call<Attachment>('completeAttachment', { attachmentId: created.id })
    expect(completed.status).toBe('queued')

    const message = await call<Message>(
      'postMessage',
      { conversationId },
      { content: 'What is in here?', attachmentIds: [created.id] },
    )
    expect(message.payload).toMatchObject({
      type: 'user_message',
      text: 'What is in here?',
      attachments: [{ id: created.id }],
    })
    expect(message.content).toBe(
      `What is in here?\n\n[Attached files, saved in the VM]\n- ${created.path} (image/png, ${png.length} B)`,
    )
    await host.idle()

    const last = requests.at(-1)?.messages.at(-1)
    expect(last?.role).toBe('user')
    const parts = last?.content ?? []
    expect(parts.some((p) => p.type === 'text' && p.text.includes(created.path))).toBe(true)
    expect(parts.find((p) => p.type === 'image')).toMatchObject({
      width: 20,
      height: 10,
      mediaType: 'image/png',
    })
  })

  it('accepts a message with only attachments and refuses an empty one', async () => {
    await expect(call('postMessage', { conversationId }, { content: '  ' })).rejects.toThrow(
      /Invalid request/,
    )
    const created = await call<Attachment>('createAttachment', { conversationId }, { name: 'a.txt', size: 1 })
    await call(
      'uploadAttachmentChunk',
      { attachmentId: created.id },
      { offset: 0, data: Buffer.from('a').toString('base64') },
    )
    await expect(
      call('postMessage', { conversationId }, { content: '', attachmentIds: [created.id] }),
    ).rejects.toThrow(/not finished/)
    await call('completeAttachment', { attachmentId: created.id })
    const message = await call<Message>(
      'postMessage',
      { conversationId },
      { content: '', attachmentIds: [created.id] },
    )
    expect(message.content.startsWith('[Attached files, saved in the VM]')).toBe(true)
    await host.idle()
  })
})
