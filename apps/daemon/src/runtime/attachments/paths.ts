import { posix } from 'node:path'

import { type Bot, type ConversationSummary, type MessageAttachment, slugify } from '@milibot/shared'

import { formatBytesEn } from '../../util/format'
import { localDay } from '../../util/time'

const UPLOADS_ROOT = '/workspace/uploads'

/** ASCII slug for folder names ("Squad Dev!" → "squad-dev"). */
export function folderSlug(text: string): string {
  return slugify(text, { maxLength: 48, normalize: 'NFKD' })
}

/** Folder of a conversation under /workspace/uploads: the bot's slug in a DM, the group's name in a group. */
export function conversationSlug(
  conversation: Pick<ConversationSummary, 'id' | 'type' | 'title' | 'memberBotIds'>,
  bots: Array<Pick<Bot, 'id' | 'slug'>>,
): string {
  if (conversation.type === 'direct') {
    const bot = bots.find((b) => b.id === conversation.memberBotIds[0])
    if (bot) return bot.slug
  }
  const fromTitle = folderSlug(conversation.title ?? '')
  if (fromTitle) return fromTitle
  return `${conversation.type === 'group' ? 'group' : 'chat'}-${conversation.id.slice(-6).toLowerCase()}`
}

/** "name.ext" (n = 1), "name (2).ext", "name (3).ext"… */
export function numberedName(name: string, n: number): string {
  if (n <= 1) return name
  const ext = posix.extname(name)
  const stem = ext && ext !== name ? name.slice(0, -ext.length) : name
  return `${stem} (${n})${ext}`
}

/** `name` or "name (2).ext", "name (3).ext"… — the first one not `taken`. */
export function uniqueName(name: string, taken: (candidate: string) => boolean): string {
  for (let n = 1; ; n++) {
    const candidate = numberedName(name, n)
    if (!taken(candidate)) return candidate
  }
}

/** `/workspace/uploads/<conversation-slug>/<yyyy-mm-dd>`. */
export function uploadDir(slug: string, at: number): string {
  return posix.join(UPLOADS_ROOT, slug, localDay(at))
}

const MENTIONED_PATH = /`(\/workspace\/[^`\n]+)`|(?<![\w./~-])(\/workspace\/[^\s`'"<>()[\]{}|*]+)/g
const IMAGE_EXTENSION = /\.(?:png|jpe?g|webp|gif)$/i

/**
 * Image files under /workspace a text mentions, in order and without repeats: whole inline code spans
 * (paths with spaces) or bare paths, trailing punctuation dropped, never resolving outside /workspace.
 */
export function mentionedImagePaths(text: string, max: number): string[] {
  const found: string[] = []
  for (const match of text.matchAll(MENTIONED_PATH)) {
    const raw = (match[1] ?? match[2] ?? '').trim().replace(/[.,;:!?]+$/, '')
    const path = posix.normalize(raw)
    if (!path.startsWith('/workspace/') || !IMAGE_EXTENSION.test(path) || found.includes(path)) continue
    found.push(path)
    if (found.length >= max) break
  }
  return found
}

/**
 * The text of a user message as the models read it: what the user typed plus where each attached file
 * is in the VM (the CLI engines read them themselves, images included; API models also get the images).
 */
export function userMessageContent(text: string, attachments: MessageAttachment[]): string {
  if (!attachments.length) return text
  const lines = attachments.map((a) => `- ${a.path} (${a.mimeType || 'file'}, ${formatBytesEn(a.size)})`)
  const block = `[Attached files, saved in the VM]\n${lines.join('\n')}`
  return text.trim() ? `${text}\n\n${block}` : block
}

/** A bot's shared file as the models read it: the caption plus where the file is in the VM. */
export function sharedFileContent(caption: string, file: MessageAttachment): string {
  const block = `[Shared file, saved in the VM]\n- ${file.path} (${file.mimeType || 'file'}, ${formatBytesEn(file.size)})`
  return caption.trim() ? `${caption}\n\n${block}` : block
}
