import { z } from 'zod'

/*
 * Chunked uploads (chat attachments, knowledge documents, board images): a create call with the file's name
 * and size, base64 chunks of at most `UPLOAD_CHUNK_BYTES` at increasing offsets, then a complete call.
 */

export const UPLOAD_CHUNK_BYTES = 512 * 1024

export const UploadFileBody = z.object({
  name: z.string().trim().min(1).max(255),
  size: z.number().int().nonnegative(),
  mimeType: z.string().max(255).default(''),
})
export type UploadFileBody = z.input<typeof UploadFileBody>

export const UploadChunkBody = z.object({
  offset: z.number().int().nonnegative(),
  data: z.string().max(Math.ceil(UPLOAD_CHUNK_BYTES / 3) * 4),
})
export type UploadChunkBody = z.input<typeof UploadChunkBody>

export const UploadChunkResult = z.object({ received: z.number().int() })

export const UploadProgress = z.object({
  id: z.string(),
  name: z.string(),
  size: z.number().int(),
  received: z.number().int(),
})
export type UploadProgress = z.infer<typeof UploadProgress>
