import { z } from 'zod'

import { endpoint, Ok } from '../http/endpoint'
import { parseCron, ScheduleError, validateRoutineCron } from './cron'

/*
 * Routines: a bot's scheduled tasks. At each run the bot takes a turn in its DM with the routine prompt (a
 * `routine_run` card before it). Created by the bot (`routine_create`) or in the bot settings.
 */

/**
 * `running`: the turn is queued or in progress; `waiting`: the run is due but held (VM off in a
 * workspace that suspends it, or the daily spend limit); `skipped`: missed while the app/VM was off
 * and the catch-up setting says to skip; `interrupted`: the runtime stopped mid-run.
 */
export const RoutineStatus = z.enum([
  'running',
  'waiting',
  'ok',
  'error',
  'cancelled',
  'skipped',
  'interrupted',
])
export type RoutineStatus = z.infer<typeof RoutineStatus>

export const Routine = z.object({
  id: z.string(),
  botId: z.string(),
  name: z.string(),
  prompt: z.string(),
  /** 5-field cron expression in the host's local time zone. */
  cron: z.string(),
  enabled: z.boolean(),
  lastRunAt: z.number().int().nullable(),
  lastStatus: RoutineStatus.nullable(),
  nextRunAt: z.number().int().nullable(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
})
export type Routine = z.infer<typeof Routine>

/** A run whose time passed while the app, the host or the VM was off. */
export const RoutineCatchUp = z.enum(['once', 'skip'])
export type RoutineCatchUp = z.infer<typeof RoutineCatchUp>

export const ROUTINE_LIMITS = {
  name: 80,
  prompt: 4000,
  perBot: 50,
} as const

const CronExpression = z
  .string()
  .trim()
  .min(1)
  .superRefine((value, ctx) => {
    try {
      validateRoutineCron(value)
    } catch (err) {
      ctx.addIssue({
        code: 'custom',
        message: err instanceof ScheduleError ? err.message : 'Invalid schedule',
      })
    }
  })
  .transform((value) => parseCron(value).source)

const CreateRoutineBody = z.object({
  name: z.string().trim().min(1).max(ROUTINE_LIMITS.name),
  prompt: z.string().trim().min(1).max(ROUTINE_LIMITS.prompt),
  cron: CronExpression,
  enabled: z.boolean().optional(),
})

const UpdateRoutineBody = CreateRoutineBody.partial()

const ListRoutinesQuery = z.object({ botId: z.string().optional() })

export const routineEndpoints = {
  listRoutines: endpoint({
    method: 'GET',
    path: '/w/:workspaceId/routines',
    query: ListRoutinesQuery,
    response: z.array(Routine),
  }),
  createRoutine: endpoint({
    method: 'POST',
    path: '/w/:workspaceId/bots/:botId/routines',
    body: CreateRoutineBody,
    response: Routine,
  }),
  updateRoutine: endpoint({
    method: 'PATCH',
    path: '/w/:workspaceId/routines/:routineId',
    body: UpdateRoutineBody,
    response: Routine,
  }),
  deleteRoutine: endpoint({ method: 'DELETE', path: '/w/:workspaceId/routines/:routineId', response: Ok }),
  /** Boots the VM if needed; refused while bots are held by the spend limit. */
  runRoutine: endpoint({
    method: 'POST',
    path: '/w/:workspaceId/routines/:routineId/run',
    response: Routine,
  }),
}
