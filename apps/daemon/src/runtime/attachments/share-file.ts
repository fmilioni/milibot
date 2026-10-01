import { posix } from 'node:path'

import type { BlobStore, NewAgentMessage, ToolExecContext, ToolResult } from '@milibot/agent'
import { textArg, type ToolArgs, toolError, toolText } from '@milibot/agent/tools'
import type { AttachmentImage, Bot, LogFn, Message } from '@milibot/shared'
import { newId } from '@milibot/shared'

import { errorMessage } from '../../errors'
import { formatBytesEn } from '../../util/format'
import { sanitizeFileName } from '../../util/safe-path'
import { mimeFromName } from '../files'
import { ToolSwitch } from '../tools-core'
import { botLinuxUser, type GuestClient, GuestError, isVmRunning, type VmController } from '../vm'
import type { WorkspaceStore } from '../workspace-store'
import { MAX_MODEL_IMAGE_BYTES, maxFileMb, MB } from './limits'
import type { AttachmentEvents } from './notify'
import { conversationSlug, sharedFileContent, uniqueName, uploadDir } from './paths'
import { type AttachmentStore, toMessageAttachment } from './store'
import { freePath, storedImage } from './vm-files'

const SHARE_COPY_TIMEOUT_MS = 10 * 60_000

export interface ShareFileToolsDeps {
  store: WorkspaceStore
  attachments: AttachmentStore
  events: AttachmentEvents
  vm: Pick<VmController, 'status' | 'runningGuest'>
  blobs: BlobStore
  /** Where a bot's card goes for a turn's conversation (its DM when the turn is bot-to-bot). */
  cardConversation: (bot: Bot, conversationId: string | null) => string
  appendMessage: (message: NewAgentMessage) => Message
  now: () => number
  copyChunkBytes: number
  log?: LogFn
}

/**
 * `share_file`: copies a bot's file (as the bot, `umask 002`) into /workspace/uploads, so the chat keeps what
 * was shared even if the bot changes the original, and posts it as a bot message.
 */
export class ShareFileTools extends ToolSwitch {
  readonly name = 'attachments'
  protected readonly handlers = {
    share_file: (ctx: ToolExecContext, a: ToolArgs) => this.shareFile(ctx, a),
  }

  constructor(private readonly deps: ShareFileToolsDeps) {
    super()
  }

  private async shareFile(ctx: ToolExecContext, a: ToolArgs): Promise<ToolResult> {
    const { store, attachments } = this.deps
    const given = textArg(a, 'path')
    const source = given ? posix.normalize(given) : ''
    if (!source.startsWith('/workspace/'))
      return toolError('"path" must be an absolute path under /workspace (copy the file there first).')
    const caption = textArg(a, 'caption', 500)
    if (!isVmRunning(this.deps.vm)) return toolError('The VM is not running.')
    const guest = this.deps.vm.runningGuest()
    let size: number
    try {
      size = (await guest.fsReadChunk(source, 0, 1)).size
    } catch (err) {
      if (err instanceof GuestError && err.code === 'path_not_found')
        return toolError(`${source} does not exist.`)
      if (err instanceof GuestError && err.code === 'not_a_file')
        return toolError(`${source} is not a file. To share a folder, zip it first and share the zip.`)
      return toolError(`Could not read ${source}: ${errorMessage(err)}`)
    }
    const limitMb = maxFileMb(store.settings)
    if (size > limitMb * MB)
      return toolError(
        `The file has ${formatBytesEn(size)}; files in the chat can have up to ${limitMb} MB ` +
          '(the user can raise it in the settings). Split or compress it.',
      )

    const conversationId = this.deps.cardConversation(ctx.bot, ctx.conversationId)
    const conversation = store.conversations.get(conversationId)
    const dir = uploadDir(conversationSlug(conversation, store.bots.list()), this.deps.now())
    const name = uniqueName(sanitizeFileName(posix.basename(source)), (candidate) =>
      attachments.pathTaken(posix.join(dir, candidate)),
    )
    const target = await freePath(guest, posix.join(dir, name), (p) => attachments.pathTaken(p))
    const copied = await guest.exec({
      user: botLinuxUser(ctx.bot.slug),
      cmd: 'umask 002 && mkdir -p -- "$(dirname -- "$TARGET")" && cp -- "$SOURCE" "$TARGET"',
      env: { SOURCE: source, TARGET: target },
      timeoutMs: SHARE_COPY_TIMEOUT_MS,
    })
    if (copied.code !== 0)
      return toolError(`Could not copy the file: ${(copied.stderr || copied.stdout).trim().slice(0, 300)}`)

    const image = await this.sharedImage(guest, target, size)
    const id = newId('attachment')
    attachments.insertReady({
      id,
      conversationId,
      messageId: null,
      name: posix.basename(target),
      size,
      mimeType: image?.mediaType ?? mimeFromName(target),
      path: target,
      image,
    })
    const file = toMessageAttachment(attachments.row(id))
    const message = this.deps.appendMessage({
      conversationId,
      authorType: 'bot',
      authorBotId: ctx.bot.id,
      kind: 'text',
      content: sharedFileContent(caption, file),
      payload: { type: 'text', streaming: false, turnId: ctx.turnId, text: caption, attachments: [file] },
      turnId: ctx.turnId,
    })
    attachments.bind([id], message.id)
    this.deps.events.changed(id)
    return toolText(
      `Shared ${posix.basename(target)} (${formatBytesEn(size)}) in the chat; the copy is at ${target}.`,
    )
  }

  /** Thumbnail (and model image) of a shared PNG/JPEG small enough for the models. */
  private async sharedImage(guest: GuestClient, path: string, size: number): Promise<AttachmentImage | null> {
    if (size === 0 || size > MAX_MODEL_IMAGE_BYTES || !/\.(png|jpe?g)$/i.test(path)) return null
    try {
      const bytes = await guest.fsReadAll(path, {
        chunkBytes: this.deps.copyChunkBytes,
        maxBytes: MAX_MODEL_IMAGE_BYTES,
      })
      return await storedImage(this.deps.blobs, new Uint8Array(bytes))
    } catch (err) {
      this.deps.log?.('info', 'shared image without thumbnail', { path, err: errorMessage(err) })
      return null
    }
  }
}
