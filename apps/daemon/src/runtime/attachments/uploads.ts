import { existsSync, mkdirSync } from 'node:fs'
import { open, readFile, rm } from 'node:fs/promises'
import { join, posix } from 'node:path'

import type { BlobStore } from '@milibot/agent'
import {
  type Attachment,
  type AttachmentImage,
  type LogFn,
  type MessageAttachment,
  newId,
  type UploadChunkBody,
  type UploadFileBody,
} from '@milibot/shared'

import { DaemonError, errorMessage } from '../../errors'
import { sanitizeFileName } from '../../util/safe-path'
import { assertUploadComplete, mimeFromName, writeChunkAt } from '../files'
import { isVmRunning, type VmController, VmCopyQueue } from '../vm'
import type { WorkspaceStore } from '../workspace-store'
import { MAX_MODEL_IMAGE_BYTES, maxFileMb, MB } from './limits'
import type { AttachmentEvents } from './notify'
import { conversationSlug, uniqueName, uploadDir } from './paths'
import { type AttachmentRow, type AttachmentStore, toAttachment, toMessageAttachment } from './store'
import { freePath, storedImage } from './vm-files'

const ABANDONED_UPLOAD_MS = 24 * 60 * 60 * 1000
const SETTLE_TIMEOUT_MS = 120_000

export interface AttachmentUploadsDeps {
  store: WorkspaceStore
  attachments: AttachmentStore
  events: AttachmentEvents
  vm: Pick<VmController, 'status' | 'runningGuest' | 'subscribe'>
  blobs: BlobStore
  /** Host folder of the bytes not in the VM yet (`<wsDir>/uploads`). */
  stagingDir: string
  now: () => number
  copyChunkBytes: number
  log?: LogFn
}

/**
 * Composer attachments: staged on the host while uploading, then copied into the VM through the guest
 * agent's fs API (owner `agent`; the setgid folders of /workspace give them the `workspace` group). With the
 * VM off they stay `queued` and are copied once it runs again.
 */
export class AttachmentUploads {
  private readonly copies: VmCopyQueue
  private stopped = false

  constructor(private readonly deps: AttachmentUploadsDeps) {
    this.copies = new VmCopyQueue({
      name: 'attachment copy',
      vm: deps.vm,
      run: () => this.copyQueued(),
      log: deps.log,
    })
  }

  start(): void {
    for (const id of this.deps.attachments.recover(this.deps.now() - ABANDONED_UPLOAD_MS)) {
      this.deps.attachments.delete(id)
      void rm(this.stagingPath(id), { force: true })
    }
    this.copies.start()
  }

  async stop(): Promise<void> {
    this.stopped = true
    await this.copies.stop()
  }

  stagingPath(id: string): string {
    return join(this.deps.stagingDir, id)
  }

  /** The bytes still on the host (not copied into the VM yet), or null. */
  stagedFile(id: string): string | null {
    const row = this.deps.attachments.row(id)
    const path = this.stagingPath(id)
    return row.status !== 'uploading' && existsSync(path) ? path : null
  }

  create(conversationId: string, body: UploadFileBody): Attachment {
    const { store, attachments } = this.deps
    const conversation = store.conversations.get(conversationId)
    if (conversation.type === 'internal')
      throw new DaemonError('validation_failed', 'Attachments go to direct or group conversations')
    const limitMb = maxFileMb(store.settings)
    if (body.size > limitMb * MB)
      throw new DaemonError('validation_failed', `The file is larger than ${limitMb} MB`, {
        reason: 'too_large',
        maxFileMb: limitMb,
      })
    const dir = uploadDir(conversationSlug(conversation, store.bots.list()), this.deps.now())
    const name = uniqueName(sanitizeFileName(body.name), (candidate) =>
      attachments.pathTaken(posix.join(dir, candidate)),
    )
    const id = newId('attachment')
    mkdirSync(this.deps.stagingDir, { recursive: true })
    attachments.insertUpload({
      id,
      conversationId,
      name,
      size: body.size,
      mimeType: body.mimeType || mimeFromName(name),
      path: posix.join(dir, name),
    })
    return this.deps.events.changed(id)
  }

  async writeChunk(id: string, chunk: UploadChunkBody): Promise<{ received: number }> {
    const row = this.deps.attachments.row(id)
    if (row.status !== 'uploading') throw new DaemonError('conflict', 'The upload is already complete')
    const received = await writeChunkAt(this.stagingPath(id), row.received, row.size, chunk)
    this.deps.attachments.setReceived(id, received)
    return { received }
  }

  async complete(id: string): Promise<Attachment> {
    const row = this.deps.attachments.row(id)
    if (row.status !== 'uploading') return toAttachment(row)
    const file = this.stagingPath(id)
    await assertUploadComplete(file, row.received, row.size)
    const image = await this.modelImage(file, row.size)
    this.deps.attachments.queue(id, image, image?.mediaType ?? row.mime_type)
    const attachment = this.deps.events.changed(id)
    void this.copies.kick()
    return attachment
  }

  /** PNG/JPEG small enough for the models: stored in the blob store with its size. */
  private async modelImage(file: string, size: number): Promise<AttachmentImage | null> {
    if (size === 0 || size > MAX_MODEL_IMAGE_BYTES) return null
    return storedImage(this.deps.blobs, new Uint8Array(await readFile(file)))
  }

  async delete(id: string): Promise<void> {
    const row = this.deps.attachments.row(id)
    if (row.message_id) throw new DaemonError('conflict', 'The attachment was already sent')
    this.deps.attachments.delete(id)
    await rm(this.stagingPath(id), { force: true })
    if (row.status === 'ready' && isVmRunning(this.deps.vm)) {
      await this.deps.vm
        .runningGuest()
        .exec({
          user: 'agent',
          cmd: 'rm -f -- "$ATTACHMENT_PATH"',
          env: { ATTACHMENT_PATH: row.vm_path },
          timeoutMs: 15_000,
        })
        .catch(() => undefined)
    }
  }

  /** Validates attachments for a new message of `conversationId` (in the given order). */
  claim(conversationId: string, ids: string[]): MessageAttachment[] {
    return [...new Set(ids)].map((id) => {
      const row = this.deps.attachments.row(id)
      if (row.conversation_id !== conversationId)
        throw new DaemonError('validation_failed', 'The attachment belongs to another conversation')
      if (row.message_id) throw new DaemonError('conflict', 'The attachment was already sent')
      if (row.status === 'uploading') throw new DaemonError('conflict', 'The upload has not finished')
      if (row.status === 'failed')
        throw new DaemonError('conflict', `The attachment failed: ${row.error ?? ''}`)
      return toMessageAttachment(row)
    })
  }

  /**
   * Resolves once the given attachments are in the VM, when it is running (the turn then starts
   * with the files in place); with the VM off it resolves right away and they are copied on boot.
   */
  async settle(ids: string[]): Promise<void> {
    const deadline = this.deps.now() + SETTLE_TIMEOUT_MS
    while (isVmRunning(this.deps.vm) && this.deps.now() < deadline) {
      const pending = ids.some((id) => {
        const status = this.deps.attachments.find(id)?.status
        return status === 'queued' || status === 'copying'
      })
      if (!pending) return
      await this.copies.kick()
    }
  }

  private async copyQueued(): Promise<void> {
    for (;;) {
      if (this.stopped || !isVmRunning(this.deps.vm)) return
      const row = this.deps.attachments.nextQueued()
      if (!row) return
      await this.copy(row)
    }
  }

  private async copy(row: AttachmentRow): Promise<void> {
    const { attachments, events } = this.deps
    attachments.setStatus(row.id, 'copying')
    events.changed(row.id, 0)
    try {
      const guest = this.deps.vm.runningGuest()
      const path = await freePath(guest, row.vm_path, (p) => attachments.pathTaken(p, row.id))
      if (path !== row.vm_path) attachments.setStatus(row.id, 'copying', { vmPath: path })
      const file = this.stagingPath(row.id)
      const chunkBytes = this.deps.copyChunkBytes
      const handle = await open(file, 'r')
      try {
        let offset = 0
        do {
          const buffer = Buffer.alloc(Math.min(chunkBytes, row.size - offset))
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset)
          await guest.fsWriteChunk(path, buffer.subarray(0, bytesRead).toString('base64'), {
            append: offset > 0,
            owner: 'agent',
          })
          offset += bytesRead
          if (offset < row.size) events.changed(row.id, offset / row.size)
          if (bytesRead === 0) break
        } while (offset < row.size)
      } finally {
        await handle.close()
      }
      attachments.setStatus(row.id, 'ready')
      await rm(file, { force: true })
      events.changed(row.id)
    } catch (err) {
      const message = errorMessage(err)
      if (!isVmRunning(this.deps.vm)) {
        attachments.setStatus(row.id, 'queued')
        events.changed(row.id)
        return
      }
      this.deps.log?.('warn', 'attachment copy failed', { attachmentId: row.id, err: message })
      attachments.setStatus(row.id, 'failed', { error: message.slice(0, 300) })
      events.changed(row.id)
    }
  }
}
