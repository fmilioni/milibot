import { z } from 'zod'

import { ConversationSummary } from '../chat/conversations'
import { endpoint, Ok } from '../http/endpoint'
import { Bot, CreateBotBody, UpdateBotBody } from './bots'

// Apart from `bots.ts`: work sessions need `BotStatus` without pulling in the chat schemas.

export const CreateBotResponse = z.object({
  bot: Bot,
  conversation: ConversationSummary,
})

export const botEndpoints = {
  listBots: endpoint({ method: 'GET', path: '/w/:workspaceId/bots', response: z.array(Bot) }),
  createBot: endpoint({
    method: 'POST',
    path: '/w/:workspaceId/bots',
    body: CreateBotBody,
    response: CreateBotResponse,
  }),
  updateBot: endpoint({
    method: 'PATCH',
    path: '/w/:workspaceId/bots/:botId',
    body: UpdateBotBody,
    response: Bot,
  }),
  deleteBot: endpoint({ method: 'DELETE', path: '/w/:workspaceId/bots/:botId', response: Ok }),
}
