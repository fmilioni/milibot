import { z } from 'zod'

import { endpoint, Ok } from '../http/endpoint'

/**
 * A request a bot set aside (`after_current_work`) until its work in progress ends. `waiting`: not taken up
 * yet (also while the turn that wakes the bot with it waits to run, or when that turn stopped midway);
 * `woken`: that turn ran; `dropped`: cancelled by the bot, the user, a stop or the deletion of its
 * conversation.
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
  /** Turns queued to wake the bot with it; it stays waiting, no longer woken, after `SET_ASIDE_MAX_WAKES`. */
  attempts: z.number().int(),
  /**
   * When the turn that woke the bot with it started acting (its first tool call). A request still waiting
   * with it set was left midway by that turn (an error, a stop, a restart): it is never woken again, so the
   * work is not done twice, and stays pending for the bot or the user.
   */
  actedAt: z.number().nullable(),
  /** When the idle watch told someone the bot was stopped with it; null = never. */
  alertedAt: z.number().nullable(),
})
export type SetAsideRequest = z.infer<typeof SetAsideRequest>

/** Wakes that did not run (an error, a stop, a restart) before a request is left for the bot or the user. */
export const SET_ASIDE_MAX_WAKES = 3

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
