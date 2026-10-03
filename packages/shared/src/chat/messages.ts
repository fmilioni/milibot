import { z } from 'zod'

import { BoardCounts, BoardStatus, DueDate } from '../boards/boards'
import { AuthorType, Progress } from '../core/schemas'
import { ModelChoice } from '../models/reasoning'
import { EditedFile } from '../work/file-edits'
import { PlanExecution, PlanStatus } from '../work/plans'
import { SessionChangeTotals, WorkSessionStatus } from '../work/sessions'
import { MessageAttachment } from './attachments'
import { QuestionAnswer, SecretScope, UserQuestion } from './user-requests'

/*
 * `Message.kind` picks the renderer, `payload.type` carries its data, `content` is always a plain-text
 * fallback (search, previews, the models' context), so an unknown payload still shows something.
 *
 * kind           payload.type
 * text           null | 'text' | 'user_message'   (streams through message.delta)
 * activity       'activity'                       (the tool steps of one bot turn)
 * card           every other payload
 * system_event   'system'                         (centered line, i18n by `event`)
 */

export const TextPayload = z.object({
  type: z.literal('text'),
  /** True while the bot is still generating; final content arrives in `message.updated`. */
  streaming: z.boolean(),
  turnId: z.string().nullable(),
  /** Files the bot shared (`share_file`) or images under /workspace its final text mentions. */
  attachments: z.array(MessageAttachment).optional(),
  /** What the chat shows when `content` adds lines only for the models (a shared file's path). */
  text: z.string().optional(),
})
export type TextPayload = z.infer<typeof TextPayload>

export const ActivityStepStatus = z.enum(['running', 'ok', 'error', 'cancelled'])
export type ActivityStepStatus = z.infer<typeof ActivityStepStatus>

/** `kind` is a stable key for icons/i18n (`ACTIVITY_STEP_KINDS`); `detail` is short human text ("ls -la"). */
export const ActivityStep = z.object({
  toolCallId: z.string(),
  tool: z.string(),
  kind: z.string(),
  detail: z.string(),
  status: ActivityStepStatus,
  startedAt: z.number().int(),
  finishedAt: z.number().int().nullable(),
  durationMs: z.number().int().nullable(),
  error: z.string().nullable(),
  /** Taken by (or after) this step. */
  screenshotSha: z.string().nullable(),
  /** What the step produced (e.g. a helper's report). */
  result: z.string().optional(),
  /** Files the step changed; the patches come from `GET /w/:ws/tool-calls/:toolCallId/diff`. */
  files: z.array(EditedFile).optional(),
})
export type ActivityStep = z.infer<typeof ActivityStep>

export const ActivityPayload = z.object({
  type: z.literal('activity'),
  turnId: z.string(),
  status: z.enum(['running', 'done', 'error', 'cancelled']),
  steps: z.array(ActivityStep),
})
export type ActivityPayload = z.infer<typeof ActivityPayload>

export const BotMessageSentPayload = z.object({
  type: z.literal('bot_message_sent'),
  targetBotId: z.string(),
  internalConversationId: z.string().nullable(),
  preview: z.string(),
  awaitReply: z.boolean(),
  /** Sent as an update (expects no reply): the target's answer stays in their private conversation. */
  notice: z.boolean().optional(),
  status: z.enum(['waiting', 'replied', 'delivered', 'timeout', 'failed']),
  replyPreview: z.string().optional(),
})
export type BotMessageSentPayload = z.infer<typeof BotMessageSentPayload>

/** In the receiving bot's own chat: another bot messaged it (links to their private conversation). */
export const BotMessageReceivedPayload = z.object({
  type: z.literal('bot_message_received'),
  fromBotId: z.string(),
  internalConversationId: z.string(),
  preview: z.string(),
  status: z.enum(['waiting', 'replied', 'delivered', 'failed']),
  replyPreview: z.string().optional(),
})
export type BotMessageReceivedPayload = z.infer<typeof BotMessageReceivedPayload>

export const ConfirmationPayload = z.object({
  type: z.literal('confirmation'),
  confirmationId: z.string(),
  /** Machine key of the action, e.g. `delete_bot`, `remove_member`. */
  action: z.string(),
  description: z.string(),
  status: z.enum(['pending', 'approved', 'rejected', 'expired']),
  /** Names for the card title, e.g. `{botName, groupName}`. */
  params: z.record(z.string(), z.string()).optional(),
})
export type ConfirmationPayload = z.infer<typeof ConfirmationPayload>

export const ErrorPayload = z.object({
  type: z.literal('error'),
  /** e.g. `provider_error`, `no_provider`, `max_steps`, `cli_usage_limit` (`CLI_ERROR_CODES`). */
  code: z.string(),
  detail: z.string(),
  /** Values the app words the code with, e.g. `{engine}` of a CLI engine's error. */
  params: z.record(z.string(), z.string()).optional(),
})
export type ErrorPayload = z.infer<typeof ErrorPayload>

export const ProcedureSavedPayload = z.object({
  type: z.literal('procedure_saved'),
  procedureId: z.string(),
  botId: z.string().nullable(),
  name: z.string(),
  scope: z.enum(['bot', 'global']),
  steps: z.number().int(),
})
export type ProcedureSavedPayload = z.infer<typeof ProcedureSavedPayload>

/** A bot saved a skill (`skill_save`). */
export const SkillCreatedPayload = z.object({
  type: z.literal('skill_created'),
  skillId: z.string(),
  botId: z.string(),
  name: z.string(),
  description: z.string(),
  /** Who could use it when saved. */
  scope: z.enum(['me', 'all']),
  files: z.number().int(),
  /** It replaced a skill of the same bot with that name. */
  updated: z.boolean(),
})
export type SkillCreatedPayload = z.infer<typeof SkillCreatedPayload>

/** Daily spend limit reached: the warning, or the pause (`paused`). */
export const SpendWarningPayload = z.object({
  type: z.literal('spend_warning'),
  spentUsd: z.number(),
  warnUsd: z.number(),
  limitUsd: z.number().nullable(),
  paused: z.boolean().optional(),
})
export type SpendWarningPayload = z.infer<typeof SpendWarningPayload>

/** A persona change a bot applied (to itself or another bot), with its diff. */
export const PromptUpdatedPayload = z.object({
  type: z.literal('prompt_updated'),
  versionId: z.string(),
  botId: z.string(),
  authorBotId: z.string().nullable(),
  reason: z.string(),
  diff: z.string(),
  added: z.number().int(),
  removed: z.number().int(),
  undone: z.boolean().optional(),
})
export type PromptUpdatedPayload = z.infer<typeof PromptUpdatedPayload>

export const RoutineCreatedPayload = z.object({
  type: z.literal('routine_created'),
  routineId: z.string(),
  botId: z.string(),
  name: z.string(),
  cron: z.string(),
  nextRunAt: z.number().int().nullable(),
})
export type RoutineCreatedPayload = z.infer<typeof RoutineCreatedPayload>

/** The bot reads it as a user instruction: `content` is the full text the model gets, now and in the history. */
export const RoutineRunPayload = z.object({
  type: z.literal('routine_run'),
  routineId: z.string(),
  botId: z.string(),
  name: z.string(),
  prompt: z.string(),
  /** Caught up after its time passed. */
  late: z.boolean(),
  manual: z.boolean(),
})
export type RoutineRunPayload = z.infer<typeof RoutineRunPayload>

/** `text` is what the user typed; `content` adds the file paths for the models. */
export const UserMessagePayload = z.object({
  type: z.literal('user_message'),
  text: z.string(),
  attachments: z.array(MessageAttachment),
})
export type UserMessagePayload = z.infer<typeof UserMessagePayload>

export const TaskStatus = z.enum(['open', 'review', 'done', 'failed'])
export type TaskStatus = z.infer<typeof TaskStatus>

export const TaskPayload = z.object({
  type: z.literal('task'),
  title: z.string(),
  status: TaskStatus,
  /** Cards with the same url are updated in place. */
  url: z.string().nullable(),
  repo: z.string().nullable(),
  prNumber: z.number().int().nullable(),
  branch: z.string().nullable(),
  botId: z.string().nullable(),
})
export type TaskPayload = z.infer<typeof TaskPayload>

/** Why a pending user request stopped waiting without an answer. */
export const UserRequestExpiredReason = z.enum(['stopped', 'timeout', 'bot_deleted'])
export type UserRequestExpiredReason = z.infer<typeof UserRequestExpiredReason>

/** The secret value never appears in the payload or `content`. */
export const SecretRequestPayload = z.object({
  type: z.literal('secret_request'),
  requestId: z.string(),
  botId: z.string(),
  /** Secret name (`{{secret:NAME}}`, env var name when `asEnv`). */
  name: z.string(),
  label: z.string(),
  reason: z.string(),
  asEnv: z.boolean(),
  status: z.enum(['pending', 'answered', 'declined', 'expired']),
  remember: z.boolean().optional(),
  scope: SecretScope.optional(),
  expiredReason: UserRequestExpiredReason.optional(),
})
export type SecretRequestPayload = z.infer<typeof SecretRequestPayload>

/** Answers are not secret: they are kept in `content`. */
export const QuestionPayload = z.object({
  type: z.literal('question'),
  requestId: z.string(),
  botId: z.string(),
  questions: z.array(UserQuestion),
  /** `answered_in_chat`: the user wrote a normal message while it was pending. */
  status: z.enum(['pending', 'answered', 'answered_in_chat', 'declined', 'expired']),
  answers: z.array(QuestionAnswer).optional(),
  expiredReason: UserRequestExpiredReason.optional(),
})
export type QuestionPayload = z.infer<typeof QuestionPayload>

/** One card per submission; the latest one follows the plan's status and steps. */
export const PlanPayload = z.object({
  type: z.literal('plan'),
  planId: z.string(),
  botId: z.string(),
  title: z.string(),
  summary: z.string(),
  revision: z.number().int(),
  status: PlanStatus,
  execution: PlanExecution,
  /** Model the bot asked for its session. */
  model: ModelChoice.nullable().optional(),
  steps: Progress,
  feedback: z.string().nullable().optional(),
  /** Once opened; it may belong to another bot. */
  sessionId: z.string().nullable().optional(),
  removed: z.boolean().optional(),
})
export type PlanPayload = z.infer<typeof PlanPayload>

/** Updated in place as its frames change. */
export const DesignPayload = z.object({
  type: z.literal('design'),
  designId: z.string(),
  botId: z.string(),
  name: z.string(),
  frameCount: z.number().int(),
  /** Small render of the first frame, once the VM rendered one. */
  thumbnailSha: z.string().nullable(),
  archived: z.boolean().optional(),
  removed: z.boolean().optional(),
})
export type DesignPayload = z.infer<typeof DesignPayload>

/** In the chat where the session started; once finished `content` is what the bot reads about it later. */
export const WorkSessionPayload = z.object({
  type: z.literal('work_session'),
  sessionId: z.string(),
  botId: z.string(),
  title: z.string(),
  goal: z.string(),
  status: WorkSessionStatus,
  steps: Progress,
  planId: z.string().nullable().optional(),
  planConversationId: z.string().nullable().optional(),
  resultSummary: z.string().nullable().optional(),
  changes: SessionChangeTotals.nullable().optional(),
  removed: z.boolean().optional(),
})
export type WorkSessionPayload = z.infer<typeof WorkSessionPayload>

/** First message of a session's conversation (`content` is what the bot reads). */
export const SessionBriefPayload = z.object({
  type: z.literal('session_brief'),
  sessionId: z.string(),
  botId: z.string(),
  title: z.string(),
  goal: z.string(),
  planId: z.string().nullable(),
  projectId: z.string().nullable(),
  repoName: z.string().nullable(),
  cwd: z.string().nullable(),
  cardId: z.string().nullable().optional(),
})
export type SessionBriefPayload = z.infer<typeof SessionBriefPayload>

export const SystemEventName = z.enum([
  'bot_created',
  'turn_stopped',
  'user_took_control',
  'user_released_control',
  'max_steps_reached',
  'session_rotated',
  'group_created',
  'member_added',
  'member_removed',
  'bot_deleted',
  'teach_started',
  'routine_updated',
  'routine_deleted',
  /** params: `projectName` (null = no project), `actor` user|bot, `actorName`. */
  'project_changed',
])
export type SystemEventName = z.infer<typeof SystemEventName>

/** The app renders it from `event` + `params`; `content` is an English fallback. */
export const SystemPayload = z.object({
  type: z.literal('system'),
  event: SystemEventName,
  botId: z.string().nullable(),
  params: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
})
export type SystemPayload = z.infer<typeof SystemPayload>

/** Updated in place as its cards move. */
export const BoardPayload = z.object({
  type: z.literal('board'),
  boardId: z.string(),
  botId: z.string(),
  title: z.string(),
  summary: z.string(),
  status: BoardStatus,
  counts: BoardCounts,
  dueDate: DueDate.nullable(),
  archived: z.boolean().optional(),
  removed: z.boolean().optional(),
})
export type BoardPayload = z.infer<typeof BoardPayload>

export const GeneratedImageStatus = z.enum(['generating', 'ready', 'failed'])
export type GeneratedImageStatus = z.infer<typeof GeneratedImageStatus>

/** Updated in place as each picture lands; `content` lists their paths in the VM. */
export const GeneratedImagesPayload = z.object({
  type: z.literal('generated_images'),
  botId: z.string(),
  model: z.string(),
  prompts: z.array(z.string()),
  images: z.array(
    z.object({
      promptIndex: z.number().int(),
      status: GeneratedImageStatus,
      /** PNG/JPEG blob; null while generating, on failure or for other formats. */
      sha: z.string().nullable(),
      path: z.string().nullable(),
      width: z.number().int().nullable(),
      height: z.number().int().nullable(),
      failure: z.enum(['quota', 'rate_limited', 'blocked', 'error']).optional(),
    }),
  ),
  costUsd: z.number().nullable(),
})
export type GeneratedImagesPayload = z.infer<typeof GeneratedImagesPayload>

/**
 * A bot started the OAuth sign-in of an MCP server: the user opens `authorizationUrl` in the system browser
 * and the redirect comes back to the runtime's loopback listener. `cancelled`: another sign-in replaced it.
 */
export const McpSignInPayload = z.object({
  type: z.literal('mcp_sign_in'),
  serverId: z.string(),
  serverName: z.string(),
  botId: z.string(),
  authorizationUrl: z.string(),
  status: z.enum(['pending', 'connected', 'failed', 'expired', 'cancelled']),
  /** Who signed in, when the server says. */
  account: z.string().nullable().optional(),
  error: z.string().optional(),
})
export type McpSignInPayload = z.infer<typeof McpSignInPayload>

export const MessagePayload = z.discriminatedUnion('type', [
  TextPayload,
  ActivityPayload,
  BotMessageSentPayload,
  BotMessageReceivedPayload,
  ConfirmationPayload,
  ErrorPayload,
  SystemPayload,
  ProcedureSavedPayload,
  SkillCreatedPayload,
  SpendWarningPayload,
  RoutineCreatedPayload,
  PromptUpdatedPayload,
  RoutineRunPayload,
  TaskPayload,
  UserMessagePayload,
  SecretRequestPayload,
  QuestionPayload,
  PlanPayload,
  WorkSessionPayload,
  SessionBriefPayload,
  DesignPayload,
  BoardPayload,
  GeneratedImagesPayload,
  McpSignInPayload,
])
export type MessagePayload = z.infer<typeof MessagePayload>

export const MessageKind = z.enum(['text', 'system_event', 'activity', 'card'])
export type MessageKind = z.infer<typeof MessageKind>

export const Message = z.object({
  id: z.string(),
  conversationId: z.string(),
  authorType: AuthorType,
  authorBotId: z.string().nullable(),
  kind: MessageKind,
  content: z.string(),
  payload: MessagePayload.nullable(),
  createdAt: z.number().int(),
})
export type Message = z.infer<typeof Message>
