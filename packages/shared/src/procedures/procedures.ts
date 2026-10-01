import { z } from 'zod'

import { endpoint, Ok } from '../http/endpoint'
import { Language } from '../workspace/workspace'

/*
 * Procedures the user taught a bot by doing them on its desktop: a model turns the recording (clicks with
 * screenshots, typed text, shortcuts, narration) into a structured procedure bots load as a skill.
 */

export const ProcedureScope = z.enum(['bot', 'global'])
export type ProcedureScope = z.infer<typeof ProcedureScope>

export const ProcedureStatus = z.enum(['recording', 'generating', 'ready'])
export type ProcedureStatus = z.infer<typeof ProcedureStatus>

export const ProcedureStepKind = z.enum([
  'click',
  'double_click',
  'right_click',
  'middle_click',
  'drag',
  'scroll',
  'type',
  'key',
  'other',
])
export type ProcedureStepKind = z.infer<typeof ProcedureStepKind>

export const ProcedureStep = z.object({
  id: z.string(),
  position: z.number().int(),
  kind: ProcedureStepKind,
  instruction: z.string(),
  /** What to click/type into, described so it can be found on a different screen. */
  target: z.string().nullable(),
  /** Text typed or keys pressed; `{{name}}` marks a parameter. */
  value: z.string().nullable(),
  /** Native 1280x800 coordinates; only a hint, layouts change. */
  x: z.number().int().nullable(),
  y: z.number().int().nullable(),
  narration: z.string().nullable(),
  /** Screen at the click. */
  screenshotSha: z.string().nullable(),
})
export type ProcedureStep = z.infer<typeof ProcedureStep>

export const ProcedureParameter = z.object({
  name: z.string(),
  description: z.string(),
  example: z.string().nullable(),
})
export type ProcedureParameter = z.infer<typeof ProcedureParameter>

export const Procedure = z.object({
  id: z.string(),
  /** null = every bot of the workspace can use it. */
  botId: z.string().nullable(),
  scope: ProcedureScope,
  /** Bot whose desktop the recording was made on. */
  taughtByBotId: z.string().nullable(),
  name: z.string(),
  goal: z.string(),
  preconditions: z.array(z.string()),
  parameters: z.array(ProcedureParameter),
  status: ProcedureStatus,
  steps: z.array(ProcedureStep),
  /** The model could not write the procedure and the recording was kept as is. */
  error: z.string().nullable(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
})
export type Procedure = z.infer<typeof Procedure>

const ListProceduresQuery = z.object({
  /** Procedures this bot can use (its own + global); omitted = every procedure. */
  botId: z.string().optional(),
})

const Coord = z.number().int().min(0).max(4096)

/** One user input recorded from the noVNC canvas (native 1280x800 coordinates). */
export const RecordedStep = z.object({
  kind: ProcedureStepKind.exclude(['other']),
  at: z.number().int(),
  x: Coord.optional(),
  y: Coord.optional(),
  toX: Coord.optional(),
  toY: Coord.optional(),
  text: z.string().max(10_000).optional(),
  /** xdotool style, e.g. `ctrl+s`, `Return`. */
  keys: z.string().max(200).optional(),
  direction: z.enum(['up', 'down', 'left', 'right']).optional(),
  amount: z.number().int().min(1).max(1000).optional(),
  narration: z.string().max(2000).optional(),
  screenshotSha: z.string().optional(),
})
export type RecordedStep = z.infer<typeof RecordedStep>

const StartTeachBody = z.object({
  /** Gets the "started teaching" line (usually the bot's DM). */
  conversationId: z.string().nullable().optional(),
  name: z.string().trim().max(120).default(''),
})

const TeachScreenshotBody = z.object({ x: Coord.optional(), y: Coord.optional() })

export const TeachScreenshotResult = z.object({
  sha256: z.string(),
  width: z.number().int(),
  height: z.number().int(),
})
export type TeachScreenshotResult = z.infer<typeof TeachScreenshotResult>

export const FinishTeachBody = z.object({
  name: z.string().trim().min(1).max(120),
  scope: ProcedureScope.default('bot'),
  steps: z.array(RecordedStep).min(1).max(500),
  language: Language.optional(),
})
export type FinishTeachBody = z.input<typeof FinishTeachBody>

export const UpdateProcedureBody = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  goal: z.string().max(4000).optional(),
  scope: ProcedureScope.optional(),
  preconditions: z.array(z.string().max(1000)).max(50).optional(),
  steps: z
    .array(
      z.object({
        id: z.string(),
        instruction: z.string().max(2000).optional(),
        narration: z.string().max(2000).nullable().optional(),
      }),
    )
    .optional(),
  deleteStepIds: z.array(z.string()).optional(),
})
export type UpdateProcedureBody = z.input<typeof UpdateProcedureBody>

export const procedureEndpoints = {
  listProcedures: endpoint({
    method: 'GET',
    path: '/w/:workspaceId/procedures',
    query: ListProceduresQuery,
    response: z.array(Procedure),
  }),
  getProcedure: endpoint({
    method: 'GET',
    path: '/w/:workspaceId/procedures/:procedureId',
    response: Procedure,
  }),
  updateProcedure: endpoint({
    method: 'PATCH',
    path: '/w/:workspaceId/procedures/:procedureId',
    body: UpdateProcedureBody,
    response: Procedure,
  }),
  /** Also cancels a recording. */
  deleteProcedure: endpoint({
    method: 'DELETE',
    path: '/w/:workspaceId/procedures/:procedureId',
    response: Ok,
  }),
  /** Starts recording on the bot's desktop and posts the "started teaching" line in the conversation. */
  startTeach: endpoint({
    method: 'POST',
    path: '/w/:workspaceId/bots/:botId/teach',
    body: StartTeachBody,
    response: Procedure,
  }),
  /** Screenshot of the bot's desktop for a recorded click. */
  teachScreenshot: endpoint({
    method: 'POST',
    path: '/w/:workspaceId/procedures/:procedureId/screenshots',
    body: TeachScreenshotBody,
    response: TeachScreenshotResult,
  }),
  /** Ends the recording; the procedure is written in the background (`procedure.updated` when ready). */
  finishTeach: endpoint({
    method: 'POST',
    path: '/w/:workspaceId/procedures/:procedureId/finish',
    body: FinishTeachBody,
    response: Procedure,
  }),
}
