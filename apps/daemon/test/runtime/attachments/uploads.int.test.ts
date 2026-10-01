import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { solidPng } from '@milibot/agent/testing'
import { ATTACHMENT_SETTING_KEYS } from '@milibot/shared'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { localDay } from '../../../src/util/time'
import { useTempDir } from '../../support/temp'
import { type AttachmentsHarness, attachmentsHarness } from './harness'

const dir = useTempDir('attachments')
let h: AttachmentsHarness
let store: AttachmentsHarness['store']
let service: AttachmentsHarness['service']
let vm: AttachmentsHarness['vm']
let vmFs: AttachmentsHarness['vmFs']
let nina: AttachmentsHarness['nina']
let dm: string
const upload: AttachmentsHarness['upload'] = (...args) => h.upload(...args)
const statuses: AttachmentsHarness['statuses'] = (...args) => h.statuses(...args)

beforeEach(() => {
  h = attachmentsHarness(dir())
  ;({ store, service, vm, vmFs, nina, dm } = h)
})

afterEach(() => h.service.stop())

describe('composer uploads', () => {
  it('puts files under /workspace/uploads/<conversation>/<day>/ with unique, safe names', () => {
    // Portuguese on purpose: accented names are kept as they are.
    const today = localDay(Date.now())
    const a = service.uploads.create(dm, {
      name: 'Relatório final.pdf',
      size: 10,
      mimeType: 'application/pdf',
    })
    const b = service.uploads.create(dm, { name: '../../etc/Relatório final.pdf', size: 10, mimeType: '' })
    expect(a.path).toBe(`/workspace/uploads/nina/${today}/Relatório final.pdf`)
    expect(b.path).toBe(`/workspace/uploads/nina/${today}/Relatório final (2).pdf`)
    expect(b.mimeType).toBe('application/pdf')
    const group = store.conversations.create({ type: 'group', botIds: [nina.id], title: 'Squad Dev!' }).id
    expect(service.uploads.create(group, { name: '.env', size: 1, mimeType: '' }).path).toBe(
      `/workspace/uploads/squad-dev/${today}/env`,
    )
  })

  it('refuses files above the size limit (setting, default 50 MB)', () => {
    expect(service.maxFileMb()).toBe(50)
    expect(() =>
      service.uploads.create(dm, { name: 'big.bin', size: 50 * 1024 * 1024 + 1, mimeType: '' }),
    ).toThrow(/larger than 50 MB/)
    store.settings.set(ATTACHMENT_SETTING_KEYS.maxFileMb, 1)
    expect(() => service.uploads.create(dm, { name: 'a.bin', size: 2 * 1024 * 1024, mimeType: '' })).toThrow(
      /larger than 1 MB/,
    )
    const ok = service.uploads.create(dm, { name: 'a.bin', size: 10, mimeType: '' })
    return expect(
      service.uploads.writeChunk(ok.id, { offset: 0, data: Buffer.alloc(11).toString('base64') }),
    ).rejects.toThrow(/declared size/)
  })

  it('queues uploads while the VM is off and copies them in chunks when it is up', async () => {
    const bytes = new Uint8Array(Array.from({ length: 2500 }, (_, i) => i % 251))
    const queued = await upload('data.csv', bytes)
    expect(queued.status).toBe('queued')
    expect(existsSync(join(dir(), 'uploads', queued.id))).toBe(true)
    expect(vmFs.files.size).toBe(0)

    vm.set('running')
    await service.settle([queued.id])
    const done = service.get(queued.id)
    expect(done.status).toBe('ready')
    expect(vmFs.files.get(done.path)).toEqual(Buffer.from(bytes))
    expect(vmFs.owners.get(done.path)).toBe('agent')
    expect(vmFs.writes).toHaveLength(3)
    expect(existsSync(join(dir(), 'uploads', queued.id))).toBe(false)
    const progress = statuses(queued.id).map((a) => [a.status, Math.round(a.progress * 100)])
    expect(progress).toEqual([
      ['uploading', 0],
      ['queued', 0],
      ['copying', 0],
      ['copying', 40],
      ['copying', 80],
      ['ready', 100],
    ])
  })

  it('copies right away with the VM running and renames when the VM already has that file', async () => {
    vm.set('running')
    const today = localDay(Date.now())
    vmFs.files.set(`/workspace/uploads/nina/${today}/note.txt`, Buffer.from('old'))
    const created = await upload('note.txt', new TextEncoder().encode('new'))
    await service.settle([created.id])
    const done = service.get(created.id)
    expect(done.path).toBe(`/workspace/uploads/nina/${today}/note (2).txt`)
    expect(vmFs.files.get(done.path)?.toString()).toBe('new')
  })

  it('keeps PNG/JPEG attachments as model images', async () => {
    const png = solidPng(40, 30, [200, 10, 10])
    const created = await upload('print.png', png)
    expect(created.mimeType).toBe('image/png')
    expect(created.image).toMatchObject({ mediaType: 'image/png', width: 40, height: 30 })
    const text = await upload('text.png', new TextEncoder().encode('not a png'))
    expect(text.image).toBeNull()
  })

  it('updates the user message when its queued file reaches the VM', async () => {
    const created = await upload('a.txt', new TextEncoder().encode('hi'))
    const attachments = service.claim(dm, [created.id])
    const message = store.messages.create({
      conversationId: dm,
      authorType: 'user',
      content: 'look',
      payload: { type: 'user_message', text: 'look', attachments },
    })
    service.bind([created.id], message.id)
    expect(() => service.claim(dm, [created.id])).toThrow(/already sent/)
    await expect(service.uploads.delete(created.id)).rejects.toThrow(/already sent/)
    vm.set('running')
    await service.settle([created.id])
    const updated = store.messages.get(message.id)
    expect(updated.payload).toMatchObject({ type: 'user_message', attachments: [{ status: 'ready' }] })
    expect(updated.content).toContain(`- ${created.path} (text/plain, 2 B)`)
  })

  it('deletes an unsent attachment from the host and the VM', async () => {
    vm.set('running')
    const created = await upload('x.txt', new TextEncoder().encode('x'))
    await service.settle([created.id])
    await service.uploads.delete(created.id)
    expect(vmFs.files.has(created.path)).toBe(false)
    expect(() => service.get(created.id)).toThrow()
  })
})
