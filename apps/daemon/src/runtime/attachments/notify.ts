import type { Attachment, LogFn, Message, MessagePayload, WorkspaceEvent } from '@milibot/shared'

import { errorMessage } from '../../errors'
import { sharedFileContent, userMessageContent } from './paths'
import { type AttachmentRow, type AttachmentStore, toAttachment, toMessageAttachment } from './store'

export interface AttachmentEventsDeps {
  attachments: AttachmentStore
  emit: (event: WorkspaceEvent) => void
  getMessage: (id: string) => Message
  updateMessage: (id: string, patch: { content?: string; payload?: MessagePayload | null }) => Message
  log?: LogFn
}

/** Tells the app an attachment changed and keeps the message that carries it in line. */
export class AttachmentEvents {
  constructor(private readonly deps: AttachmentEventsDeps) {}

  changed(id: string, progress?: number): Attachment {
    const row = this.deps.attachments.row(id)
    const attachment = toAttachment(row, progress)
    this.deps.emit({ type: 'attachment.updated', payload: { attachment } })
    if (row.message_id) this.refreshMessage(row.message_id, row)
    return attachment
  }

  private refreshMessage(messageId: string, row: AttachmentRow): void {
    try {
      const message = this.deps.getMessage(messageId)
      const payload = message.payload
      if (payload?.type !== 'user_message' && payload?.type !== 'text') return
      const current = payload.attachments ?? []
      const before = current.find((a) => a.id === row.id)
      const after = toMessageAttachment(row)
      if (!before || (before.status === after.status && before.path === after.path)) return
      const attachments = current.map((a) => (a.id === row.id ? after : a))
      if (payload.type === 'text') {
        this.deps.updateMessage(messageId, {
          ...(payload.text !== undefined && attachments.length === 1
            ? { content: sharedFileContent(payload.text, after) }
            : {}),
          payload: { ...payload, attachments },
        })
        return
      }
      this.deps.updateMessage(messageId, {
        content: userMessageContent(payload.text, attachments),
        payload: { ...payload, attachments },
      })
    } catch (err) {
      this.deps.log?.('warn', 'attachment message not updated', { messageId, err: errorMessage(err) })
    }
  }
}
