import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { type FakeStep, solidPng } from '@milibot/agent/testing'
import type { Message, MessageAttachment, WorkspaceEvent } from '@milibot/shared'
import { afterEach, describe, expect, it } from 'vitest'

import { MAX_MENTIONED_IMAGE_BYTES } from '../../../src/runtime/attachments/mentioned-images'
import type { WorkspaceRuntime } from '../../../src/runtime/runtime'
import type { FakeGuest } from '../../support/fake-guest'
import { bootRuntime, type RuntimeHarness, stopRuntimes } from '../../support/runtime-harness'
import { useTempDir } from '../../support/temp'
import { until } from '../../support/wait'

let h: RuntimeHarness
let runtime: WorkspaceRuntime
let events: WorkspaceEvent[]
let guest: FakeGuest
let dm: string
const dir = useTempDir('mentioned-images')
afterEach(stopRuntimes)

async function boot(script: FakeStep[], options: { vm: boolean } = { vm: true }) {
  h = await bootRuntime({
    dir: dir(),
    script,
    fallback: { text: 'ok' },
    host: { compaction: false },
    ...(options.vm ? {} : { vm: false as const }),
  })
  ;({ runtime, events, guest, dm } = h)
}

/** Sends a message, waits for the bot's turn and for the images it mentioned to be attached. */
async function reply(content: string): Promise<Message> {
  await h.call('postMessage', { conversationId: dm }, { content })
  let finished: { botId: string; conversationId: string; turnId: string } | undefined
  await until(() => {
    finished = events.flatMap((e) => (e.type === 'turn.finished' ? [e.payload] : [])).at(-1)
    return Boolean(finished)
  })
  await runtime.services.attachments.attachMentionedImages(finished!)
  const texts = runtime.store.messages
    .list(dm, { limit: 50 })
    .messages.filter((m) => m.authorType === 'bot' && m.kind === 'text')
  return texts.at(-1) as Message
}

const attachmentsOf = (message: Message): MessageAttachment[] =>
  message.payload?.type === 'text' ? (message.payload.attachments ?? []) : []

const GIF = Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(20)])

describe('images mentioned by a bot', () => {
  it('attaches a snapshot of each image the final reply mentions', async () => {
    await boot([
      {
        text: [
          'The preview is at `/workspace/preview/shadow avatars.png`.',
          'Animation: /workspace/preview/loop.gif; notes: /workspace/preview/notes.md.',
          'Fake: /workspace/preview/fake.png, missing: /workspace/preview/missing.png,',
          'huge: /workspace/preview/huge.png, again: `/workspace/preview/shadow avatars.png`.',
        ].join('\n'),
      },
    ])
    const png = solidPng(20, 10, [0, 0, 255])
    guest.state.files.set('/workspace/preview/shadow avatars.png', png)
    guest.state.files.set('/workspace/preview/loop.gif', new Uint8Array(GIF))
    guest.state.files.set('/workspace/preview/notes.md', '# notes')
    guest.state.files.set('/workspace/preview/fake.png', 'not an image')
    guest.state.files.set('/workspace/preview/huge.png', new Uint8Array(MAX_MENTIONED_IMAGE_BYTES + 1))

    const message = await reply('show me the preview')
    const attachments = attachmentsOf(message)
    expect(attachments).toEqual([
      {
        id: expect.stringMatching(/^att_/),
        name: 'shadow avatars.png',
        size: png.length,
        mimeType: 'image/png',
        path: '/workspace/preview/shadow avatars.png',
        status: 'ready',
        image: { sha256: expect.any(String), mediaType: 'image/png', width: 20, height: 10 },
      },
      {
        id: expect.stringMatching(/^att_/),
        name: 'loop.gif',
        size: GIF.length,
        mimeType: 'image/gif',
        path: '/workspace/preview/loop.gif',
        status: 'ready',
        image: null,
      },
    ])
    expect(message.content).toContain('`/workspace/preview/shadow avatars.png`')
    const staged = join(dir(), 'uploads', attachments[0]!.id)
    expect(new Uint8Array(readFileSync(staged))).toEqual(png)
    expect(
      events.some(
        (e) =>
          e.type === 'message.updated' &&
          e.payload.message.id === message.id &&
          attachmentsOf(e.payload.message).length === 2,
      ),
    ).toBe(true)

    guest.state.files.set('/workspace/preview/shadow avatars.png', solidPng(5, 5, [255, 0, 0]))
    const exported = await runtime.services.attachments.files.export(attachments[0]!.id)
    expect(new Uint8Array(readFileSync(exported.path))).toEqual(png)
  })

  it('attaches at most six images', async () => {
    const paths = Array.from({ length: 8 }, (_, i) => `/workspace/shots/${i}.png`)
    await boot([{ text: `Screenshots:\n${paths.map((p) => `- ${p}`).join('\n')}` }])
    for (const path of paths) guest.state.files.set(path, solidPng(4, 4, [0, 255, 0]))
    const message = await reply('take the screenshots')
    expect(attachmentsOf(message).map((a) => a.path)).toEqual(paths.slice(0, 6))
  })

  it('ignores images mentioned only in progress notes before a tool call', async () => {
    await boot([
      {
        text: 'Generating /workspace/shots/draft.png',
        toolCalls: [{ name: 'bash', arguments: { cmd: 'ls' } }],
      },
      { text: 'Done.' },
    ])
    guest.state.files.set('/workspace/shots/draft.png', solidPng(4, 4, [0, 0, 0]))
    const message = await reply('generate it')
    expect(message.content).toBe('Done.')
    expect(attachmentsOf(message)).toEqual([])
  })

  it('attaches nothing while the VM is not running', async () => {
    await boot([{ text: 'See /workspace/preview/a.png' }], { vm: false })
    const message = await reply('show me')
    expect(message.content).toBe('See /workspace/preview/a.png')
    expect(attachmentsOf(message)).toEqual([])
    expect(existsSync(join(dir(), 'uploads'))).toBe(false)
  })
})
