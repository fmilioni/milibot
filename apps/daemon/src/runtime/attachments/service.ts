import type { BlobStore, NewAgentMessage } from '@milibot/agent'
import {
  type Attachment,
  ATTACHMENT_SETTING_KEYS,
  type attachmentEndpoints,
  type Bot,
  type LogFn,
  type Message,
  type MessageAttachment,
  type MessagePayload,
  type WorkspaceEvent,
} from '@milibot/shared'

import type { EndpointHandlers } from '../../handlers'
import type { VmController } from '../vm'
import type { WorkspaceStore } from '../workspace-store'
import { FilesScreen } from './files-screen'
import { COPY_CHUNK_BYTES, maxFileMb } from './limits'
import { MentionedImages } from './mentioned-images'
import { AttachmentEvents } from './notify'
import { ShareFileTools } from './share-file'
import { AttachmentStore, toAttachment } from './store'
import { AttachmentUploads } from './uploads'

export interface AttachmentServiceDeps {
  store: WorkspaceStore
  vm: Pick<VmController, 'status' | 'runningGuest' | 'subscribe'>
  blobs: BlobStore
  /** Host folder of the bytes not in the VM yet (`<wsDir>/uploads`). */
  stagingDir: string
  emit: (event: WorkspaceEvent) => void
  getMessage: (id: string) => Message
  appendMessage: (message: NewAgentMessage) => Message
  /** Where a bot's card goes for a turn's conversation (its DM when the turn is bot-to-bot). */
  cardConversation: (bot: Bot, conversationId: string | null) => string
  updateMessage: (id: string, patch: { content?: string; payload?: MessagePayload | null }) => Message
  now: () => number
  /** Where exported copies go (default: `$TMPDIR/milibot-attachments`). */
  exportDir?: string
  copyChunkBytes?: number
  log?: LogFn
}

/**
 * The files of the chats, all kept in the VM under /workspace/uploads and copied to the host only on
 * demand: composer uploads, images a bot's reply mentions, files bots share (`share_file`) and the Files screen.
 */
export class AttachmentService {
  readonly tools: ShareFileTools
  readonly uploads: AttachmentUploads
  readonly mentioned: MentionedImages
  readonly files: FilesScreen
  private readonly attachments: AttachmentStore

  constructor(private readonly deps: AttachmentServiceDeps) {
    const copyChunkBytes = deps.copyChunkBytes ?? COPY_CHUNK_BYTES
    const attachments = (this.attachments = new AttachmentStore(deps.store.db, deps.now))
    const events = new AttachmentEvents({ ...deps, attachments })
    this.uploads = new AttachmentUploads({ ...deps, attachments, events, copyChunkBytes })
    const stagingPath = (id: string) => this.uploads.stagingPath(id)
    this.mentioned = new MentionedImages({ ...deps, attachments, stagingPath, copyChunkBytes })
    this.files = new FilesScreen({ ...deps, attachments, events, stagingPath, copyChunkBytes })
    this.tools = new ShareFileTools({ ...deps, attachments, events, copyChunkBytes })
  }

  start(): void {
    this.uploads.start()
  }

  async stop(): Promise<void> {
    await this.uploads.stop()
    await this.mentioned.stop()
  }

  maxFileMb(): number {
    return maxFileMb(this.deps.store.settings)
  }

  referencedBlobs(): string[] {
    return this.attachments.referencedBlobs()
  }

  get(id: string): Attachment {
    return toAttachment(this.attachments.row(id))
  }

  stagedFile(id: string): string | null {
    return this.uploads.stagedFile(id)
  }

  claim(conversationId: string, ids: string[]): MessageAttachment[] {
    return this.uploads.claim(conversationId, ids)
  }

  bind(ids: string[], messageId: string): void {
    this.attachments.bind(ids, messageId)
  }

  settle(ids: string[]): Promise<void> {
    return this.uploads.settle(ids)
  }

  attachMentionedImages(turn: { conversationId: string; turnId: string; botId: string }): Promise<void> {
    return this.mentioned.attach(turn)
  }

  handlers(): EndpointHandlers<keyof typeof attachmentEndpoints> {
    const { uploads, files } = this
    return {
      createAttachment: ({ params, body }) => uploads.create(params.conversationId, body),
      uploadAttachmentChunk: ({ params, body }) => uploads.writeChunk(params.attachmentId, body),
      completeAttachment: ({ params }) => uploads.complete(params.attachmentId),
      deleteAttachment: async ({ params }) => {
        await uploads.delete(params.attachmentId)
        return { ok: true as const }
      },
      exportAttachment: ({ params }) => files.export(params.attachmentId),
      listFiles: ({ query }) => files.list(query),
      renameFile: ({ params, body }) => files.rename(params.attachmentId, body.name),
      deleteFile: async ({ params }) => {
        await files.delete(params.attachmentId)
        return { ok: true as const }
      },
      getAttachmentSettings: () => ({ maxFileMb: this.maxFileMb() }),
      updateAttachmentSettings: ({ body }) => {
        if (body.maxFileMb !== undefined)
          this.deps.store.settings.set(ATTACHMENT_SETTING_KEYS.maxFileMb, body.maxFileMb)
        return { maxFileMb: this.maxFileMb() }
      },
    }
  }
}
