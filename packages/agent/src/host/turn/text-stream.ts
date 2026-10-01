import type { Bot, Message } from '@milibot/shared'

import type { ChatSink } from '../../environment'

/** Streams text into one chat message, coalescing deltas into `message.delta` events. */
export class TextStream {
  private messageId: string | null = null
  private text = ''
  private pending = ''
  private timer: NodeJS.Timeout | null = null

  constructor(
    private readonly chat: Pick<ChatSink, 'appendMessage' | 'updateMessage' | 'emitDelta'>,
    private readonly bot: Bot,
    private readonly conversationId: string,
    private readonly turnId: string,
    private readonly flushMs: number,
    /** Receives each finished text instead of the chat (a helper's turn). */
    private readonly sink: ((text: string) => void) | null = null,
  ) {}

  get started(): boolean {
    return this.messageId !== null
  }

  push(delta: string): void {
    if (!delta) return
    if (this.sink) {
      this.text += delta
      return
    }
    if (!this.messageId) {
      const message = this.chat.appendMessage({
        conversationId: this.conversationId,
        authorType: 'bot',
        authorBotId: this.bot.id,
        kind: 'text',
        content: '',
        payload: { type: 'text', streaming: true, turnId: this.turnId },
        turnId: this.turnId,
      })
      this.messageId = message.id
    }
    this.text += delta
    this.pending += delta
    this.timer ??= setTimeout(() => this.flush(), this.flushMs)
  }

  private flush(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    if (this.messageId && this.pending) this.chat.emitDelta(this.conversationId, this.messageId, this.pending)
    this.pending = ''
  }

  /** Finalizes the current message (if any) with `finalText` (defaults to the streamed text). */
  end(finalText: string | null = null): Message | null {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    const text = (finalText ?? this.text).trim()
    if (this.sink) {
      this.text = ''
      if (text) this.sink(text)
      return null
    }
    if (!this.messageId && text) this.push(text)
    this.flush()
    if (!this.messageId) return null
    const id = this.messageId
    this.messageId = null
    this.text = ''
    return this.chat.updateMessage(id, {
      content: text,
      payload: { type: 'text', streaming: false, turnId: this.turnId },
    })
  }
}
