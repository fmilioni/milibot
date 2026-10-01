import type { NewAgentMessage } from '@milibot/agent'
import type { Message, MessagePayload, WorkspaceEvent } from '@milibot/shared'

import type { WorkspaceStore } from '../workspace-store'

export interface MessageWriterDeps {
  store: WorkspaceStore
  emit: (event: WorkspaceEvent) => void
  /** Replaces secret values (workspace secrets, MCP credentials) in anything stored or sent to the app. */
  redact: <T>(value: T) => T
  /** The secret values `redact` hides (a delta must not end with the start of one). */
  secretValues: () => readonly string[]
}

export type MessagePatch = { content?: string; payload?: MessagePayload | null }

/**
 * Every message a service or the agent host writes: stored redacted, announced to the app with the
 * conversation's new summary. Streamed text is redacted as a whole: the last characters of a delta wait until
 * they can no longer be the start of a secret split across deltas (the final `message.updated` has it all).
 */
export class MessageWriter {
  private readonly streamed = new Map<string, { raw: string; sent: number }>()

  constructor(private readonly deps: MessageWriterDeps) {}

  get(id: string): Message {
    return this.deps.store.messages.get(id)
  }

  append(message: NewAgentMessage): Message {
    const created = this.deps.store.messages.create(this.deps.redact(message))
    this.deps.emit({ type: 'message.created', payload: { message: created } })
    this.conversationUpdated(created.conversationId)
    return created
  }

  update(id: string, patch: MessagePatch): Message {
    if (patch.payload?.type === 'text' && !patch.payload.streaming) this.streamed.delete(id)
    this.deps.store.messages.update(id, this.deps.redact(patch))
    const message = this.deps.store.messages.get(id)
    this.deps.emit({ type: 'message.updated', payload: { message } })
    if (message.kind === 'text') this.conversationUpdated(message.conversationId)
    return message
  }

  delete(id: string): void {
    this.streamed.delete(id)
    const conversationId = this.deps.store.messages.delete(id)
    if (!conversationId) return
    this.deps.emit({ type: 'message.deleted', payload: { conversationId, messageId: id } })
    this.conversationUpdated(conversationId)
  }

  emitDelta(conversationId: string, messageId: string, delta: string): void {
    const safe = this.safeDelta(messageId, delta)
    if (safe) this.deps.emit({ type: 'message.delta', payload: { conversationId, messageId, delta: safe } })
  }

  conversationUpdated(conversationId: string): void {
    this.deps.emit({
      type: 'conversation.updated',
      payload: { conversation: this.deps.store.conversations.get(conversationId) },
    })
  }

  private safeDelta(messageId: string, delta: string): string {
    const longest = Math.max(0, ...this.deps.secretValues().map((v) => v.length))
    const entry = this.streamed.get(messageId) ?? { raw: '', sent: 0 }
    entry.raw += delta
    this.streamed.set(messageId, entry)
    const safe = this.deps.redact(entry.raw)
    const upTo = Math.max(entry.sent, safe.length - Math.max(0, longest - 1))
    const out = safe.slice(entry.sent, upTo)
    entry.sent = upTo
    return out
  }
}
