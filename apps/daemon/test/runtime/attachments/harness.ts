import { join } from 'node:path'

import {
  type Attachment,
  type Bot,
  UPLOAD_CHUNK_BYTES,
  type VmInfo,
  type WorkspaceEvent,
} from '@milibot/shared'

import { AttachmentService } from '../../../src/runtime/attachments/service'
import { FileBlobStore } from '../../../src/runtime/blobs'
import { GuestClient, GuestError } from '../../../src/runtime/vm/guest-client'
import { WorkspaceStore } from '../../../src/runtime/workspace-store'
import { openWorkspaceDb } from '../../../src/workspace-db/open'

/** Guest agent fs of the VM in memory (`/fs/write` base64 + append, `/fs/read` with offsets). */
function memoryGuest() {
  const files = new Map<string, Buffer>()
  const folders = new Set<string>()
  /** Symlinks to outside `/workspace`, which the guest refuses to follow. */
  const escapes = new Set<string>()
  const owners = new Map<string, string | undefined>()
  const writes: string[] = []
  const execs: Array<{ user?: string; cmd: string; env?: Record<string, string> }> = []
  const guest = {
    async fsWriteChunk(path: string, base64: string, options: { append: boolean; owner?: string }) {
      writes.push(path)
      const bytes = Buffer.from(base64, 'base64')
      files.set(path, options.append ? Buffer.concat([files.get(path) ?? Buffer.alloc(0), bytes]) : bytes)
      owners.set(path, options.owner)
      return { path, size: files.get(path)?.length ?? 0 }
    },
    async fsRead(path: string) {
      const file = files.get(path)
      if (!file) throw new GuestError('path_not_found', `no such path: ${path}`, 404)
      return {
        path,
        size: file.length,
        content: file.subarray(0, 1).toString('utf8'),
        truncated: file.length > 1,
      }
    },
    async fsReadChunk(path: string, offset: number, maxBytes: number) {
      if (folders.has(path)) throw new GuestError('not_a_file', `not a file: ${path}`, 400)
      if (escapes.has(path))
        throw new GuestError('path_outside_workspace', `escapes via symlink: ${path}`, 400)
      const file = files.get(path)
      if (!file) throw new GuestError('path_not_found', `no such path: ${path}`, 404)
      const part = file.subarray(offset, offset + maxBytes)
      return {
        path,
        size: file.length,
        content: part.toString('base64'),
        truncated: offset + part.length < file.length,
      }
    },
    fsReadAll: GuestClient.prototype.fsReadAll,
    async exec(request: { user?: string; cmd: string; env?: Record<string, string> }) {
      execs.push(request)
      if (request.cmd.startsWith('rm -f')) files.delete(request.env?.ATTACHMENT_PATH ?? '')
      const { SOURCE, TARGET } = request.env ?? {}
      const { FROM, TO } = request.env ?? {}
      if (request.cmd.startsWith('mv -n') && FROM && TO) {
        const file = files.get(FROM)
        if (file && !files.has(TO)) {
          files.set(TO, file)
          files.delete(FROM)
        } else
          return {
            code: 1,
            signal: null,
            stdout: '',
            stderr: 'mv failed',
            truncated: { stdout: false, stderr: false },
            timedOut: false,
            durationMs: 1,
          }
      }
      if (request.cmd.includes('cp --') && SOURCE && TARGET) {
        const file = files.get(SOURCE)
        if (file) files.set(TARGET, Buffer.from(file))
      }
      return {
        code: 0,
        signal: null,
        stdout: '',
        stderr: '',
        truncated: { stdout: false, stderr: false },
        timedOut: false,
        durationMs: 1,
      }
    },
  }
  return { files, folders, escapes, owners, writes, execs, guest: guest as unknown as GuestClient }
}

function fakeVm(guest: GuestClient) {
  let state: VmInfo['state'] = 'stopped'
  const listeners = new Set<(info: VmInfo) => void>()
  return {
    status: () => ({ state, desktops: 0 }),
    runningGuest: () => {
      if (state !== 'running') throw new Error('VM_UNAVAILABLE')
      return guest
    },
    subscribe: (listener: (info: VmInfo) => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    set(next: VmInfo['state']) {
      state = next
      for (const listener of listeners)
        listener({
          state,
          config: { cpus: 1, memGb: 1, dataGb: 1, systemGb: 1 },
          portBase: null,
          desktops: 0,
        })
    },
  }
}

/** An `AttachmentService` over an in-memory workspace, a fake VM (stopped) and a DM with Nina. */
export function attachmentsHarness(dir: string) {
  const db = openWorkspaceDb(':memory:')
  const store = new WorkspaceStore(db, () => Date.now())
  const nina: Bot = store.bots.create({ name: 'Nina', label: 'Social', systemPrompt: '' })
  const dm = store.conversations.create({ type: 'direct', botIds: [nina.id] }).id
  const events: WorkspaceEvent[] = []
  const vmFs = memoryGuest()
  const vm = fakeVm(vmFs.guest)
  const service = new AttachmentService({
    store,
    vm,
    blobs: new FileBlobStore(join(dir, 'blobs')),
    stagingDir: join(dir, 'uploads'),
    exportDir: join(dir, 'exports'),
    vmFilesDir: join(dir, 'vm-files'),
    emit: (event) => events.push(event),
    getMessage: (id) => store.messages.get(id),
    appendMessage: (message) => store.messages.create(message),
    cardConversation: (bot, conversationId) => store.conversations.forCard(bot, conversationId),
    updateMessage: (id, patch) => {
      store.messages.update(id, patch)
      return store.messages.get(id)
    },
    now: () => Date.now(),
    copyChunkBytes: 1000,
  })
  service.start()

  async function upload(name: string, bytes: Uint8Array, conversationId = dm): Promise<Attachment> {
    const created = service.uploads.create(conversationId, { name, size: bytes.length, mimeType: '' })
    for (let offset = 0; offset < bytes.length; offset += UPLOAD_CHUNK_BYTES) {
      const data = Buffer.from(bytes.subarray(offset, offset + UPLOAD_CHUNK_BYTES)).toString('base64')
      await service.uploads.writeChunk(created.id, { offset, data })
    }
    return service.uploads.complete(created.id)
  }

  const statuses = (id: string) =>
    events.flatMap((e) =>
      e.type === 'attachment.updated' && e.payload.attachment.id === id ? [e.payload.attachment] : [],
    )

  function shareFile(args: Record<string, unknown>, conversationId: string | null = dm) {
    return service.tools.execute(
      { bot: nina, conversationId, turnId: 'turn_1', signal: new AbortController().signal } as never,
      { id: 'call_1', name: 'share_file', arguments: args },
    )
  }

  return { store, service, events, vm, vmFs, nina, dm, upload, statuses, shareFile }
}

export type AttachmentsHarness = ReturnType<typeof attachmentsHarness>
