import { z } from 'zod'

import { UserOrBot } from '../core/schemas'
import { endpoint, Ok } from '../http/endpoint'
import { UploadChunkBody, UploadChunkResult, UploadFileBody } from './uploads'

/**
 * Composer attachments: uploaded in chunks to the host (`<wsDir>/uploads/<id>`), then copied into the VM at
 * `/workspace/uploads/<conversation-slug>/<yyyy-mm-dd>/<name>`; with the VM off they wait (`queued`).
 */
export const AttachmentStatus = z.enum(['uploading', 'queued', 'copying', 'ready', 'failed', 'removed'])
export type AttachmentStatus = z.infer<typeof AttachmentStatus>

/** PNG/JPEG attachments also go to API models as images (kept in the blob store). */
export const AttachmentImage = z.object({
  sha256: z.string(),
  mediaType: z.enum(['image/png', 'image/jpeg']),
  width: z.number().int(),
  height: z.number().int(),
})
export type AttachmentImage = z.infer<typeof AttachmentImage>

export const Attachment = z.object({
  id: z.string(),
  conversationId: z.string(),
  messageId: z.string().nullable(),
  name: z.string(),
  size: z.number().int().nonnegative(),
  mimeType: z.string(),
  path: z.string(),
  status: AttachmentStatus,
  /** 0..1 while `copying`. */
  progress: z.number(),
  image: AttachmentImage.nullable(),
  error: z.string().nullable(),
  createdAt: z.number().int(),
})
export type Attachment = z.infer<typeof Attachment>

/** What a message keeps of its attachments (payload `user_message`, or images of a bot `text`). */
export const MessageAttachment = Attachment.pick({
  id: true,
  name: true,
  size: true,
  mimeType: true,
  path: true,
  status: true,
  image: true,
})
export type MessageAttachment = z.infer<typeof MessageAttachment>

export const DEFAULT_ATTACHMENT_MAX_FILE_MB = 50
export const MAX_ATTACHMENTS_PER_MESSAGE = 20

export const AttachmentSettings = z.object({
  maxFileMb: z.number().int().min(1).max(2048),
})
export type AttachmentSettings = z.infer<typeof AttachmentSettings>

const UpdateAttachmentSettingsBody = AttachmentSettings.partial()

export const FileSource = z.enum(['bots', 'user'])
export type FileSource = z.infer<typeof FileSource>

export const ListFilesQuery = z.object({
  source: FileSource.optional(),
  query: z.string().trim().max(200).optional(),
  /** Last file id of the previous page. */
  before: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
})
export type ListFilesQuery = z.input<typeof ListFilesQuery>

/** A file sent in a chat by the user (attachment) or a bot (`share_file`, mentioned images). */
export const ChatFile = z.object({
  attachment: MessageAttachment,
  conversationId: z.string(),
  messageId: z.string(),
  authorType: UserOrBot,
  authorBotId: z.string().nullable(),
  createdAt: z.number().int(),
})
export type ChatFile = z.infer<typeof ChatFile>

export const FilePage = z.object({
  files: z.array(ChatFile),
  hasMore: z.boolean(),
  /** By origin, the source filter aside. */
  counts: z.object({ all: z.number().int(), bots: z.number().int(), user: z.number().int() }),
  /** The source filter aside. */
  totalBytes: z.number().int(),
})
export type FilePage = z.infer<typeof FilePage>

const RenameFileBody = z.object({ name: z.string().trim().min(1).max(255) })

export const attachmentEndpoints = {
  /** Refused above the size limit. */
  createAttachment: endpoint({
    method: 'POST',
    path: '/w/:workspaceId/conversations/:conversationId/attachments',
    body: UploadFileBody,
    response: Attachment,
  }),
  uploadAttachmentChunk: endpoint({
    method: 'POST',
    path: '/w/:workspaceId/attachments/:attachmentId/chunks',
    body: UploadChunkBody,
    response: UploadChunkResult,
  }),
  /** Copies it into the VM now, or queues it until the VM is up. */
  completeAttachment: endpoint({
    method: 'POST',
    path: '/w/:workspaceId/attachments/:attachmentId/complete',
    response: Attachment,
  }),
  /** Only an attachment not sent yet. */
  deleteAttachment: endpoint({
    method: 'DELETE',
    path: '/w/:workspaceId/attachments/:attachmentId',
    response: Ok,
  }),
  /** Copies the file to a temporary folder on the host (to open or reveal it). */
  exportAttachment: endpoint({
    method: 'POST',
    path: '/w/:workspaceId/attachments/:attachmentId/export',
    response: z.object({ path: z.string() }),
  }),
  /** Files sent in the workspace's chats that are still in the VM, newest first. */
  listFiles: endpoint({
    method: 'GET',
    path: '/w/:workspaceId/files',
    query: ListFilesQuery,
    response: FilePage,
  }),
  /** Refused when the name is taken in its VM folder. */
  renameFile: endpoint({
    method: 'POST',
    path: '/w/:workspaceId/files/:attachmentId/rename',
    body: RenameFileBody,
    response: MessageAttachment,
  }),
  /** Its chat message shows it as removed. */
  deleteFile: endpoint({
    method: 'DELETE',
    path: '/w/:workspaceId/files/:attachmentId',
    response: Ok,
  }),
  getAttachmentSettings: endpoint({
    method: 'GET',
    path: '/w/:workspaceId/attachment-settings',
    response: AttachmentSettings,
  }),
  updateAttachmentSettings: endpoint({
    method: 'PATCH',
    path: '/w/:workspaceId/attachment-settings',
    body: UpdateAttachmentSettingsBody,
    response: AttachmentSettings,
  }),
}
