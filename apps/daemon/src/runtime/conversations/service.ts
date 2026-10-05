import type { AgentHost } from '@milibot/agent'
import type { conversationEndpoints, Message, WorkspaceEvent } from '@milibot/shared'

import { DaemonError } from '../../errors'
import type { EndpointHandlers } from '../../handlers'
import { type AttachmentService, userMessageContent } from '../attachments'
import type { WorkSessionService } from '../sessions'
import type { SetAsideService } from '../set-aside'
import type { UserRequestService } from '../user-requests'
import type { WorkspaceStore } from '../workspace-store'

export interface ConversationServiceDeps {
  store: WorkspaceStore
  emit: (event: WorkspaceEvent) => void
  host: Pick<AgentHost, 'onMessageCreated'>
  attachments: Pick<AttachmentService, 'claim' | 'bind' | 'settle'>
  userRequests: Pick<UserRequestService, 'answerFromChat'>
  workSessions: Pick<WorkSessionService, 'onUserMessage'>
  setAside: Pick<SetAsideService, 'dropConversation'>
}

/** The user's side of the chat: conversations and the messages they post. */
export class ConversationService {
  constructor(private readonly deps: ConversationServiceDeps) {}

  /**
   * A user message: it answers a pending `ask_user` when there is one, else it wakes the conversation's bots.
   * With the VM up, the turn starts once the attached files are in /workspace/uploads.
   */
  post(conversationId: string, content: string, attachmentIds: string[]): Message {
    const { store, emit, attachments } = this.deps
    const claimed = attachmentIds.length ? attachments.claim(conversationId, attachmentIds) : []
    const message = store.messages.create({
      conversationId,
      authorType: 'user',
      content: userMessageContent(content, claimed),
      ...(claimed.length
        ? { payload: { type: 'user_message' as const, text: content, attachments: claimed } }
        : {}),
    })
    if (claimed.length) attachments.bind(attachmentIds, message.id)
    const deliver = () => {
      if (this.deps.userRequests.answerFromChat(message)) return
      this.deps.workSessions.onUserMessage(conversationId)
      this.deps.host.onMessageCreated(message)
    }
    emit({ type: 'message.created', payload: { message } })
    emit({ type: 'conversation.updated', payload: { conversation: store.conversations.get(conversationId) } })
    if (claimed.length) void attachments.settle(attachmentIds).finally(deliver)
    else deliver()
    return message
  }

  handlers(): EndpointHandlers<keyof typeof conversationEndpoints> {
    const { store, emit } = this.deps
    return {
      listConversations: () => store.conversations.list(),
      getConversation: ({ params }) => store.conversations.get(params.conversationId),
      createConversation: ({ body }) => {
        const conversation = store.conversations.create({
          type: body.type,
          botIds: body.botIds,
          title: body.title ?? null,
          settings: body.settings ?? {},
        })
        emit({ type: 'conversation.created', payload: { conversation } })
        return conversation
      },
      updateConversation: ({ params, body }) => {
        const conversation = store.conversations.get(params.conversationId)
        if (conversation.type === 'direct')
          throw new DaemonError('validation_failed', 'Rename the bot to rename a direct conversation')
        store.conversations.rename(conversation.id, body.title)
        const renamed = store.conversations.get(conversation.id)
        emit({ type: 'conversation.updated', payload: { conversation: renamed } })
        return renamed
      },
      deleteConversation: ({ params }) => {
        const conversation = store.conversations.get(params.conversationId)
        if (conversation.type === 'direct')
          throw new DaemonError('validation_failed', 'Delete the bot to delete a direct conversation')
        store.conversations.softDelete(conversation.id)
        this.deps.setAside.dropConversation(conversation.id)
        emit({ type: 'conversation.deleted', payload: { conversationId: conversation.id } })
        return { ok: true as const }
      },
      markConversationRead: ({ params, body }) => {
        store.conversations.markRead(params.conversationId, body.lastReadMessageId)
        emit({
          type: 'conversation.updated',
          payload: { conversation: store.conversations.get(params.conversationId) },
        })
        return { ok: true as const }
      },
      listMessages: ({ params, query }) => store.messages.list(params.conversationId, query),
      postMessage: ({ params, body }) =>
        this.post(params.conversationId, body.content, body.attachmentIds ?? []),
    }
  }
}
