import { ATTACHMENT_SETTING_KEYS, type Message } from '@milibot/shared'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { localDay } from '../../../src/util/time'
import { useTempDir } from '../../support/temp'
import { type AttachmentsHarness, attachmentsHarness } from './harness'

const dir = useTempDir('attachments')
let h: AttachmentsHarness
let store: AttachmentsHarness['store']
let vm: AttachmentsHarness['vm']
let vmFs: AttachmentsHarness['vmFs']
let nina: AttachmentsHarness['nina']
let dm: string
const shareFile: AttachmentsHarness['shareFile'] = (...args) => h.shareFile(...args)

beforeEach(() => {
  h = attachmentsHarness(dir())
  ;({ store, vm, vmFs, nina, dm } = h)
})

afterEach(() => h.service.stop())

describe('share_file', () => {
  it('shares a bot file: a copy under /workspace/uploads posted as a bot message with the file', async () => {
    vm.set('running')
    vmFs.files.set('/workspace/out/report.zip', Buffer.from('zip bytes'))
    const result = await shareFile({ path: '/workspace/out/report.zip', caption: 'Here it is' })
    expect(result.isError).toBeFalsy()
    const target = `/workspace/uploads/${nina.slug}/${localDay(Date.now())}/report.zip`
    expect(vmFs.files.get(target)?.toString()).toBe('zip bytes')
    expect(vmFs.execs.at(-1)?.user).toBe(`bot-${nina.slug}`)

    const message = store.messages.list(dm, { limit: 10 }).messages.at(-1) as Message
    expect(message.authorBotId).toBe(nina.id)
    expect(message.content).toContain('Here it is')
    expect(message.content).toContain(target)
    expect(message.payload).toMatchObject({
      type: 'text',
      turnId: 'turn_1',
      text: 'Here it is',
      attachments: [{ name: 'report.zip', path: target, size: 9, status: 'ready' }],
    })

    const again = await shareFile({ path: '/workspace/out/report.zip' })
    expect(again.isError).toBeFalsy()
    expect(vmFs.files.has(target.replace('report.zip', 'report (2).zip'))).toBe(true)
  })

  it('refuses to share folders, missing files, files above the limit and with the VM off', async () => {
    const text = (result: Awaited<ReturnType<typeof shareFile>>) => JSON.stringify(result.content)
    expect(text(await shareFile({ path: '/workspace/x.zip' }))).toContain('not running')
    vm.set('running')
    expect(text(await shareFile({ path: '/etc/passwd' }))).toContain('under /workspace')
    expect(text(await shareFile({ path: '/workspace/missing.zip' }))).toContain('does not exist')
    vmFs.folders.add('/workspace/out')
    expect(text(await shareFile({ path: '/workspace/out' }))).toContain('zip it first')
    store.settings.set(ATTACHMENT_SETTING_KEYS.maxFileMb, 1)
    vmFs.files.set('/workspace/big.bin', Buffer.alloc(2 * 1024 * 1024))
    expect(text(await shareFile({ path: '/workspace/big.bin' }))).toContain('up to 1 MB')
    expect(store.messages.list(dm, { limit: 10 }).messages).toHaveLength(0)
  })
})
