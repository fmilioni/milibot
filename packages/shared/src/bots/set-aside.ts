import { z } from 'zod'

import { endpoint, Ok } from '../http/endpoint'

/**
 * A request a bot set aside (`after_current_work`) until its work in progress ends. `waiting`: not taken up
 * yet; `woken`: the bot was woken with it; `dropped`: cancelled by the bot, the user or a stop.
 */
export const SetAsideStatus = z.enum(['waiting', 'woken', 'dropped'])
export type SetAsideStatus = z.infer<typeof SetAsideStatus>

export const SetAsideRequest = z.object({
  id: z.string(),
  botId: z.string(),
  conversationId: z.string(),
  task: z.string(),
  /** How the work it waits for was described when it was set aside. */
  waitingOn: z.array(z.string()),
  status: SetAsideStatus,
  createdAt: z.number(),
  wokenAt: z.number().nullable(),
  /** When the idle watch told someone the bot was stopped with it; null = never. */
  alertedAt: z.number().nullable(),
})
export type SetAsideRequest = z.infer<typeof SetAsideRequest>

export const setAsideEndpoints = {
  /** The requests still waiting, oldest first (one bot's with `botId`). */
  listSetAsideRequests: endpoint({
    method: 'GET',
    path: '/w/:workspaceId/set-aside',
    query: z.object({ botId: z.string().optional() }),
    response: z.array(SetAsideRequest),
  }),
  dropSetAsideRequest: endpoint({
    method: 'DELETE',
    path: '/w/:workspaceId/set-aside/:requestId',
    response: Ok,
  }),
}
