import { z } from 'zod'

import { ActivityStepStatus } from '../chat/messages'
import { endpoint } from '../http/endpoint'

export const ScreenControl = z.enum(['bot', 'user', 'idle'])
export type ScreenControl = z.infer<typeof ScreenControl>

export const BotDisplay = z.object({
  display: z.number().int().positive(),
  vncHost: z.literal('127.0.0.1'),
  vncPort: z.number().int().positive(),
  width: z.literal(1280),
  height: z.literal(800),
  control: ScreenControl,
  paused: z.boolean(),
  busy: z.boolean(),
})
export type BotDisplay = z.infer<typeof BotDisplay>

export const BotControlAction = z.enum(['pause', 'resume', 'stop', 'takeover', 'release'])
export type BotControlAction = z.infer<typeof BotControlAction>

/** Which of the bot's lanes `stop` applies to: the chat's, one work session's (`sessionId`) or all. */
export const BotControlScope = z.enum(['chat', 'all'])
export type BotControlScope = z.infer<typeof BotControlScope>

const BotControlBody = z.object({
  action: BotControlAction,
  sessionId: z.string().optional(),
  scope: BotControlScope.optional(),
})
export type BotControlOptions = Omit<z.infer<typeof BotControlBody>, 'action'>

export const BotControlResult = z.object({
  ok: z.literal(true),
  paused: z.boolean(),
  control: ScreenControl,
})

/** One tool action of a bot (the VM panel's activity log). */
export const BotActivityAction = z.object({
  id: z.string(),
  botId: z.string(),
  conversationId: z.string().nullable(),
  turnId: z.string().nullable(),
  time: z.number().int(),
  tool: z.string(),
  kind: z.string(),
  detail: z.string(),
  status: ActivityStepStatus,
  durationMs: z.number().int().nullable(),
  error: z.string().nullable(),
  /** Whole detail (full command, typed text…) when `detail` is clipped. */
  fullDetail: z.string().optional(),
  /** Taken by (or after) this action. */
  screenshotSha: z.string().nullable().optional(),
})
export type BotActivityAction = z.infer<typeof BotActivityAction>

const BotActivityQuery = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(50),
})

export const botControlEndpoints = {
  getBotDisplay: endpoint({
    method: 'GET',
    path: '/w/:workspaceId/bots/:botId/display',
    response: BotDisplay,
  }),
  controlBot: endpoint({
    method: 'POST',
    path: '/w/:workspaceId/bots/:botId/control',
    body: BotControlBody,
    response: BotControlResult,
  }),
  getBotActivity: endpoint({
    method: 'GET',
    path: '/w/:workspaceId/bots/:botId/activity',
    query: BotActivityQuery,
    response: z.array(BotActivityAction),
  }),
}
