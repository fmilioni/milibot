import { type Attachment, DESIGN_FILE_EXTENSION, UPLOAD_CHUNK_BYTES } from '@milibot/shared'

export interface UploadDeps<Session extends { id: string } = Attachment, Result = Attachment> {
  create(body: { name: string; size: number; mimeType: string }): Promise<Session>
  chunk(uploadId: string, offset: number, data: string): Promise<{ received: number }>
  complete(uploadId: string): Promise<Result>
  /** The daemon accepted the upload (the chip can be removed on the daemon from now on). */
  onCreated?(session: Session): void
  /** 0..1 of the bytes sent to the daemon. */
  onProgress?(fraction: number): void
  signal?: AbortSignal
  chunkBytes?: number
}

export class UploadCancelled extends Error {
  constructor() {
    super('Upload cancelled')
    this.name = 'UploadCancelled'
  }
}

export function toBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(binary)
}

/**
 * Sends a file to the daemon in chunks (base64 JSON, like every other route) and completes it. Used for
 * chat attachments and knowledge documents.
 */
export async function uploadFile<Session extends { id: string }, Result>(
  file: Blob & { name: string },
  deps: UploadDeps<Session, Result>,
): Promise<Result> {
  const chunkBytes = deps.chunkBytes ?? UPLOAD_CHUNK_BYTES
  const session = await deps.create({ name: file.name, size: file.size, mimeType: file.type })
  deps.onCreated?.(session)
  deps.onProgress?.(file.size === 0 ? 1 : 0)
  for (let offset = 0; offset < file.size; offset += chunkBytes) {
    if (deps.signal?.aborted) throw new UploadCancelled()
    const bytes = new Uint8Array(await file.slice(offset, offset + chunkBytes).arrayBuffer())
    await deps.chunk(session.id, offset, toBase64(bytes))
    deps.onProgress?.(Math.min(1, (offset + bytes.length) / file.size))
  }
  if (deps.signal?.aborted) throw new UploadCancelled()
  return deps.complete(session.id)
}

export type AttachmentKind = 'image' | 'pdf' | 'text' | 'archive' | 'file'

export function attachmentKind(mimeType: string, name: string): AttachmentKind {
  const ext = name.toLowerCase().split('.').pop() ?? ''
  if (mimeType.startsWith('image/') || ['png', 'jpg', 'jpeg', 'gif', 'webp', 'heic', 'svg'].includes(ext))
    return 'image'
  if (mimeType === 'application/pdf' || ext === 'pdf') return 'pdf'
  if (['zip', 'gz', 'tgz', 'tar', 'rar', '7z', 'xz', 'bz2'].includes(ext) || mimeType.includes('zip'))
    return 'archive'
  if (
    mimeType.startsWith('text/') ||
    mimeType === 'application/json' ||
    ['txt', 'md', 'csv', 'json', 'yaml', 'yml', 'log', 'xml', 'html', 'ts', 'js', 'py'].includes(ext)
  )
    return 'text'
  return 'file'
}

/** Files given to the chat: `.mbdesign` files are imported as designs, the rest become attachments. */
export function splitDesignFiles<F extends { name: string }>(
  files: readonly F[],
): { designs: F[]; others: F[] } {
  const suffix = `.${DESIGN_FILE_EXTENSION}`
  const designs = files.filter((f) => f.name.toLowerCase().endsWith(suffix))
  return { designs, others: files.filter((f) => !designs.includes(f)) }
}

/** Name of an image pasted from the clipboard (browsers call them all "image.png"). */
export function pastedFileName(type: string, at: Date, prefix: string): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  const ext =
    type === 'image/jpeg' ? 'jpg' : (type.split('/')[1] ?? 'png').replace(/[^a-z0-9]/gi, '') || 'png'
  const stamp = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}.${pad(at.getMinutes())}.${pad(at.getSeconds())}`
  return `${prefix} ${stamp}.${ext}`
}

/** Ids to send with the message, or null while some file is still uploading to the daemon. */
export function sendableAttachmentIds(
  items: Array<{ attachment: Attachment | null; error: string | null }>,
): string[] | null {
  if (items.some((i) => !i.error && (!i.attachment || i.attachment.status === 'uploading'))) return null
  return items.flatMap((i) =>
    !i.error && i.attachment && i.attachment.status !== 'failed' ? [i.attachment.id] : [],
  )
}
