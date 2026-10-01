import { mkdirSync } from 'node:fs'
import { rm, writeFile } from 'node:fs/promises'
import { dirname, posix } from 'node:path'

import type { BlobStore } from '@milibot/agent'
import { type AttachmentImage, type LogFn, type Message, type MessagePayload, newId } from '@milibot/shared'

import { errorMessage } from '../../errors'
import { imageMediaType } from '../files'
import { type GuestClient, isVmRunning, type VmController } from '../vm'
import type { WorkspaceStore } from '../workspace-store'
import { MB } from './limits'
import { mentionedImagePaths } from './paths'
import { type AttachmentStore, toMessageAttachment } from './store'
import { storedImage } from './vm-files'

/** Images a bot mentions in its reply that are copied into the chat. */
const MAX_MENTIONED_IMAGES = 6
export const MAX_MENTIONED_IMAGE_BYTES = 10 * MB
const MENTIONED_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])

interface MentionedImage {
  id: string
  path: string
  size: number
  mimeType: string
  image: AttachmentImage | null
}

export interface MentionedImagesDeps {
  store: WorkspaceStore
  attachments: AttachmentStore
  vm: Pick<VmController, 'status' | 'runningGuest'>
  blobs: BlobStore
  /** Where the snapshot's bytes are kept on the host (`AttachmentUploads.stagingPath`). */
  stagingPath: (id: string) => string
  getMessage: (id: string) => Message
  updateMessage: (id: string, patch: { content?: string; payload?: MessagePayload | null }) => Message
  copyChunkBytes: number
  log?: LogFn
}

/**
 * Images under /workspace that the bot's final texts of a turn mention become attachments of those
 * messages: a snapshot taken when the turn ends (host copy + thumbnail), so the chat keeps what the bot
 * showed even if the file changes later. Best effort and only with the VM running; one turn at a time.
 */
export class MentionedImages {
  private pending: Promise<void> = Promise.resolve()
  private stopped = false

  constructor(private readonly deps: MentionedImagesDeps) {}

  attach(turn: { conversationId: string; turnId: string; botId: string }): Promise<void> {
    this.pending = this.pending.then(() =>
      this.snapshotTurn(turn).catch((err: unknown) =>
        this.deps.log?.('warn', 'mentioned images not attached', {
          turnId: turn.turnId,
          err: errorMessage(err),
        }),
      ),
    )
    return this.pending
  }

  async stop(): Promise<void> {
    this.stopped = true
    await this.pending
  }

  private async snapshotTurn(turn: { conversationId: string; turnId: string; botId: string }) {
    const running = () => !this.stopped && isVmRunning(this.deps.vm)
    if (!running()) return
    const messages = this.deps.store.messages
      .list(turn.conversationId, { limit: 60 })
      .messages.filter(
        (m) =>
          m.authorBotId === turn.botId &&
          m.kind === 'text' &&
          m.payload?.type === 'text' &&
          m.payload.turnId === turn.turnId &&
          !m.payload.streaming &&
          !m.payload.attachments?.length,
      )
    for (const message of messages) {
      const paths = mentionedImagePaths(message.content, MAX_MENTIONED_IMAGES)
      const snapshots: MentionedImage[] = []
      for (const path of paths) {
        if (!running()) break
        try {
          const snapshot = await this.snapshot(this.deps.vm.runningGuest(), path)
          if (snapshot) snapshots.push(snapshot)
        } catch (err) {
          this.deps.log?.('info', 'mentioned image skipped', { path, err: errorMessage(err) })
        }
      }
      if (snapshots.length) await this.attachSnapshots(message.id, snapshots)
    }
  }

  private async snapshot(guest: GuestClient, path: string): Promise<MentionedImage | null> {
    const { size } = await guest.fsReadChunk(path, 0, 1)
    if (size === 0 || size > MAX_MENTIONED_IMAGE_BYTES) return null
    const bytes = new Uint8Array(
      await guest.fsReadAll(path, {
        chunkBytes: this.deps.copyChunkBytes,
        maxBytes: MAX_MENTIONED_IMAGE_BYTES,
      }),
    )
    const mimeType = imageMediaType(bytes)
    if (!mimeType || !MENTIONED_IMAGE_TYPES.has(mimeType)) return null
    const id = newId('attachment')
    const staged = this.deps.stagingPath(id)
    mkdirSync(dirname(staged), { recursive: true })
    await writeFile(staged, bytes)
    return { id, path, size: bytes.length, mimeType, image: await storedImage(this.deps.blobs, bytes) }
  }

  private async attachSnapshots(messageId: string, snapshots: MentionedImage[]): Promise<void> {
    const discard = () => Promise.all(snapshots.map((s) => rm(this.deps.stagingPath(s.id), { force: true })))
    let message: Message
    try {
      message = this.deps.getMessage(messageId)
    } catch {
      await discard()
      return
    }
    const payload = message.payload
    if (payload?.type !== 'text' || payload.attachments?.length) {
      await discard()
      return
    }
    for (const s of snapshots)
      this.deps.attachments.insertReady({
        id: s.id,
        conversationId: message.conversationId,
        messageId,
        name: posix.basename(s.path),
        size: s.size,
        mimeType: s.mimeType,
        path: s.path,
        image: s.image,
      })
    const attachments = snapshots.map((s) => toMessageAttachment(this.deps.attachments.row(s.id)))
    this.deps.updateMessage(messageId, { payload: { ...payload, attachments } })
  }
}
