import { z } from 'zod'

import { endpoint, Ok } from '../http/endpoint'
import { MAX_ATTACHMENTS_PER_MESSAGE } from './attachments'
import { Message } from './messages'

export const ConversationType = z.enum(['direct', 'group', 'internal', 'session'])
export type ConversationType = z.infer<typeof ConversationType>

export const GroupSettings = z.object({
  respondWithoutMention: z.boolean(),
  botsCanManageMembers: z.boolean(),
  maxConsecutiveBotMessages: z.number().int().positive(),
  /** Bot requests to remove a member wait for the user's confirmation. */
  confirmRemovals: z.boolean(),
})
export type GroupSettings = z.infer<typeof GroupSettings>

export const Conversation = z.object({
  id: z.string(),
  type: ConversationType,
  title: z.string().nullable(),
  settings: GroupSettings.partial(),
  /** null = general. */
  projectId: z.string().nullable(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
  lastMessageAt: z.number().int().nullable(),
})
export type Conversation = z.infer<typeof Conversation>

/** Where a conversation sits in the sidebar (ordering rules in `sidebar.ts`). */
export const SidebarPlacement = z.object({
  sectionId: z.string().nullable(),
  order: z.number().int(),
  pinned: z.boolean(),
  hidden: z.boolean(),
  unreadCount: z.number().int().nonnegative(),
})
export type SidebarPlacement = z.infer<typeof SidebarPlacement>

export const ConversationSummary = Conversation.extend({
  memberBotIds: z.array(z.string()),
  lastMessage: Message.nullable(),
  sidebar: SidebarPlacement,
})
export type ConversationSummary = z.infer<typeof ConversationSummary>

const CreateConversationBody = z.object({
  type: z.enum(['direct', 'group']),
  title: z.string().trim().max(64).nullable().optional(),
  botIds: z.array(z.string()).min(1),
  settings: GroupSettings.partial().optional(),
})

const UpdateConversationBody = z.object({
  title: z.string().trim().max(64).nullable(),
})

const ListMessagesQuery = z.object({
  before: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
})

export const MessagePage = z.object({
  messages: z.array(Message),
  hasMore: z.boolean(),
})
export type MessagePage = z.infer<typeof MessagePage>

const PostMessageBody = z
  .object({
    content: z.string().trim().max(100_000),
    /** Uploaded with `createAttachment` in the same conversation. */
    attachmentIds: z.array(z.string()).max(MAX_ATTACHMENTS_PER_MESSAGE).optional(),
  })
  .refine((body) => body.content.length > 0 || (body.attachmentIds?.length ?? 0) > 0, {
    message: 'A message needs text or attachments',
    path: ['content'],
  })

const CONVERSATION = '/w/:workspaceId/conversations/:conversationId'

export const conversationEndpoints = {
  listConversations: endpoint({
    method: 'GET',
    path: '/w/:workspaceId/conversations',
    response: z.array(ConversationSummary),
  }),
  getConversation: endpoint({ method: 'GET', path: CONVERSATION, response: ConversationSummary }),
  createConversation: endpoint({
    method: 'POST',
    path: '/w/:workspaceId/conversations',
    body: CreateConversationBody,
    response: ConversationSummary,
  }),
  updateConversation: endpoint({
    method: 'PATCH',
    path: CONVERSATION,
    body: UpdateConversationBody,
    response: ConversationSummary,
  }),
  /** Groups only; a direct conversation goes away with its bot. */
  deleteConversation: endpoint({ method: 'DELETE', path: CONVERSATION, response: Ok }),
  markConversationRead: endpoint({
    method: 'POST',
    path: `${CONVERSATION}/read`,
    body: z.object({ lastReadMessageId: z.string().optional() }),
    response: Ok,
  }),
  listMessages: endpoint({
    method: 'GET',
    path: `${CONVERSATION}/messages`,
    query: ListMessagesQuery,
    response: MessagePage,
  }),
  postMessage: endpoint({
    method: 'POST',
    path: `${CONVERSATION}/messages`,
    body: PostMessageBody,
    response: Message,
  }),
}
