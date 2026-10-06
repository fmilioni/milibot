import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'

import { ATTACHMENT_SETTING_KEYS } from '@milibot/shared'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

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
const shareFile: AttachmentsHarness['shareFile'] = (...args) => h.shareFile(...args)

beforeEach(() => {
  h = attachmentsHarness(dir())
  ;({ store, service, vm, vmFs, nina, dm } = h)
})

afterEach(() => h.service.stop())

describe('the Files screen', () => {
  it('exports a copy to the host from the staging area or from the VM', async () => {
    const created = await upload('photo.jpg', new TextEncoder().encode('jpeg?'))
    const staged = await service.files.export(created.id)
    expect(readFileSync(staged.path, 'utf8')).toBe('jpeg?')
    vm.set('running')
    await service.settle([created.id])
    rmSync(staged.path)
    const fromVm = await service.files.export(created.id)
    expect(fromVm.path.endsWith('/photo.jpg')).toBe(true)
    expect(readFileSync(fromVm.path, 'utf8')).toBe('jpeg?')
  })

  it('exports under a host-safe name whatever the VM path holds', async () => {
    const created = await upload('photo.png', new TextEncoder().encode('png?'))
    store.db
      .prepare('UPDATE attachments SET vm_path = ? WHERE id = ?')
      .run('/workspace/..\\..\\AppData\\Roaming\\Startup\\nul.png', created.id)
    const exported = await service.files.export(created.id)
    expect(exported.path).toBe(join(dir(), 'exports', created.id, '_nul.png'))
    expect(readFileSync(exported.path, 'utf8')).toBe('png?')
  })

  it('lists the files sent in the chats by origin and name', async () => {
    vm.set('running')
    const sent = await upload('notes.txt', new TextEncoder().encode('n'))
    const userMessage = store.messages.create({
      conversationId: dm,
      authorType: 'user',
      kind: 'text',
      content: 'notes',
      payload: null,
    })
    service.bind([sent.id], userMessage.id)
    await upload('draft.txt', new TextEncoder().encode('d'))
    vmFs.files.set('/workspace/report.zip', Buffer.from('z'))
    await shareFile({ path: '/workspace/report.zip' })

    const all = service.files.list({})
    expect(all.files.map((f) => f.attachment.name)).toEqual(['report.zip', 'notes.txt'])
    expect(all.files[0]).toMatchObject({ authorType: 'bot', authorBotId: nina.id, conversationId: dm })
    expect(service.files.list({ source: 'user' }).files.map((f) => f.attachment.name)).toEqual(['notes.txt'])
    expect(service.files.list({ source: 'bots' }).files.map((f) => f.attachment.name)).toEqual(['report.zip'])
    expect(service.files.list({ query: 'NOTE' }).files).toHaveLength(1)
    expect(service.files.list({ source: 'user' })).toMatchObject({
      counts: { all: 2, bots: 1, user: 1 },
      totalBytes: 2,
    })
    const first = service.files.list({ limit: 1 })
    expect(first.hasMore).toBe(true)
    expect(
      service.files.list({ limit: 1, before: first.files[0]?.attachment.id }).files[0]?.attachment.name,
    ).toBe('notes.txt')
  })

  it('deletes a shared file from the VM and shows it as removed in its message', async () => {
    vm.set('running')
    vmFs.files.set('/workspace/report.zip', Buffer.from('z'))
    await shareFile({ path: '/workspace/report.zip' })
    const file = service.files.list({}).files[0]
    if (!file) throw new Error('no file')
    await service.files.delete(file.attachment.id)
    expect(vmFs.files.has(file.attachment.path)).toBe(false)
    expect(service.files.list({}).files).toEqual([])
    expect(store.messages.get(file.messageId).payload).toMatchObject({
      attachments: [{ id: file.attachment.id, status: 'removed' }],
    })
    await expect(service.files.export(file.attachment.id)).rejects.toMatchObject({
      details: { code: 'FILE_REMOVED' },
    })
  })

  it('renames a shared file in its VM folder and keeps the message on the new path', async () => {
    vm.set('running')
    vmFs.files.set('/workspace/report.zip', Buffer.from('z'))
    await shareFile({ path: '/workspace/report.zip', caption: 'Here' })
    const file = service.files.list({}).files[0]
    if (!file) throw new Error('no file')
    const renamed = await service.files.rename(file.attachment.id, 'final/../report 2024.zip')
    expect(renamed.name).toBe('report 2024.zip')
    expect(renamed.path.startsWith(file.attachment.path.replace('report.zip', ''))).toBe(true)
    expect(vmFs.files.has(renamed.path)).toBe(true)
    expect(vmFs.files.has(file.attachment.path)).toBe(false)
    const message = store.messages.get(file.messageId)
    expect(message.content).toContain(renamed.path)
    expect(message.payload).toMatchObject({ text: 'Here', attachments: [{ path: renamed.path }] })

    vmFs.files.set('/workspace/other.zip', Buffer.from('o'))
    await shareFile({ path: '/workspace/other.zip' })
    const other = service.files.list({}).files[0]
    if (!other) throw new Error('no file')
    await expect(service.files.rename(other.attachment.id, renamed.name)).rejects.toMatchObject({
      details: { code: 'NAME_TAKEN' },
    })
  })

  it('marks a file removed when the VM no longer has it', async () => {
    vm.set('running')
    vmFs.files.set('/workspace/report.zip', Buffer.from('z'))
    await shareFile({ path: '/workspace/report.zip' })
    const file = service.files.list({}).files[0]
    if (!file) throw new Error('no file')
    vmFs.files.delete(file.attachment.path)
    await expect(service.files.export(file.attachment.id)).rejects.toMatchObject({
      details: { code: 'FILE_REMOVED' },
    })
    expect(service.get(file.attachment.id).status).toBe('removed')
  })
})

describe('opening a /workspace file from a link', () => {
  const code = async (promise: Promise<unknown>) =>
    promise.then(
      () => null,
      (err: { details?: { code?: string } }) => err.details?.code,
    )

  it('copies the file to the host, fresh on every call', async () => {
    vm.set('running')
    vmFs.files.set('/workspace/milibot/NOTES.md', Buffer.from('v1'))
    const first = await service.files.exportPath('/workspace/milibot/NOTES.md')
    expect(first.path.startsWith(join(dir(), 'vm-files'))).toBe(true)
    expect(first.path.endsWith('/NOTES.md')).toBe(true)
    expect(readFileSync(first.path, 'utf8')).toBe('v1')
    vmFs.files.set('/workspace/milibot/NOTES.md', Buffer.from('version 2'))
    const second = await service.files.exportPath('/workspace/milibot/NOTES.md')
    expect(second.path).toBe(first.path)
    expect(readFileSync(second.path, 'utf8')).toBe('version 2')
  })

  it('refuses paths outside /workspace, folders, missing files and a stopped VM', async () => {
    expect(await code(service.files.exportPath('/workspace/a.md'))).toBe('VM_NOT_RUNNING')
    vm.set('running')
    expect(await code(service.files.exportPath('/etc/passwd'))).toBe('NOT_A_FILE')
    expect(await code(service.files.exportPath('/workspace/../etc/passwd'))).toBe('NOT_A_FILE')
    expect(await code(service.files.exportPath('/workspace/gone.md'))).toBe('FILE_REMOVED')
    vmFs.folders.add('/workspace/milibot')
    expect(await code(service.files.exportPath('/workspace/milibot'))).toBe('NOT_A_FILE')
  })

  it('refuses a file above the chats size limit', async () => {
    vm.set('running')
    store.settings.set(ATTACHMENT_SETTING_KEYS.maxFileMb, 1)
    vmFs.files.set('/workspace/big.bin', Buffer.alloc(1024 * 1024 + 1))
    expect(await code(service.files.exportPath('/workspace/big.bin'))).toBe('FILE_TOO_LARGE')
  })
})
