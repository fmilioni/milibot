import { z } from 'zod'

import { Board, BoardCard } from '../boards/boards'
import { Bot, BotStatus } from '../bots/bots'
import { BotActivityAction } from '../bots/control'
import { Attachment } from '../chat/attachments'
import { ConversationSummary } from '../chat/conversations'
import { Message } from '../chat/messages'
import { SidebarSection } from '../chat/sidebar'
import { Design, DesignFrame } from '../designs/designs'
import { KnowledgeDoc, KnowledgeIndexStatus } from '../knowledge/knowledge'
import { OfficeStatus } from '../knowledge/office'
import { McpServer } from '../mcp/mcp'
import { CliUsage } from '../models/cli'
import { Procedure } from '../procedures/procedures'
import { Routine } from '../routines/routines'
import { Skill } from '../skills/skills'
import { VmInfo } from '../vm/vm'
import { Plan } from '../work/plans'
import { Project } from '../work/projects'
import { SessionChangeTotals, WorkSession } from '../work/sessions'
import { BackupJob, BackupRestore } from '../workspace/backup'
import { GoldenStatus } from '../workspace/setup'
import { AppSettings, RuntimeStatus, WorkspaceStatus, WorkspaceSummary } from '../workspace/workspace'
import { TurnTrigger } from './turn-trigger'

function event<T extends string, P extends z.ZodType>(type: T, payload: P) {
  return z.object({ type: z.literal(type), payload })
}

/** Events broadcast on `/events` (app level). */
export const AppEvent = z.discriminatedUnion('type', [
  event('workspace.created', z.object({ workspace: WorkspaceSummary })),
  event('workspace.updated', z.object({ workspace: WorkspaceSummary })),
  event('workspace.deleted', z.object({ workspaceId: z.string() })),
  event('app_settings.updated', z.object({ settings: AppSettings })),
  event('golden.status', z.object({ status: GoldenStatus })),
])
export type AppEvent = z.infer<typeof AppEvent>

/** Events broadcast on `/w/:workspaceId/events`, emitted by the workspace runtime or supervisor. */
export const WorkspaceEvent = z.discriminatedUnion('type', [
  event('workspace.updated', z.object({ workspace: WorkspaceSummary })),
  event('runtime.status', z.object({ status: RuntimeStatus })),
  event('workspace.status', z.object({ status: WorkspaceStatus })),
  event('bot.created', z.object({ bot: Bot })),
  event('bot.updated', z.object({ bot: Bot })),
  event('bot.deleted', z.object({ botId: z.string() })),
  event(
    'bot.status',
    z.object({
      botId: z.string(),
      status: BotStatus,
      detail: z.string().optional(),
      /** Bot being messaged while `detail` is `ask_bot`/`message_bot`. */
      targetBotId: z.string().optional(),
      /** The status comes from this work session's lane; the bot's chat lane is idle. */
      sessionId: z.string().optional(),
      conversationId: z.string().optional(),
    }),
  ),
  event('conversation.created', z.object({ conversation: ConversationSummary })),
  event('conversation.updated', z.object({ conversation: ConversationSummary })),
  event('conversation.deleted', z.object({ conversationId: z.string() })),
  event('sidebar.sections', z.object({ sections: z.array(SidebarSection) })),
  event('message.created', z.object({ message: Message })),
  /** Chunk of a `text` message created with `payload.streaming = true`. */
  event('message.delta', z.object({ conversationId: z.string(), messageId: z.string(), delta: z.string() })),
  /** Full replacement (final streamed text, activity step progress, card status). */
  event('message.updated', z.object({ message: Message })),
  event('bot.activity', z.object({ botId: z.string(), action: BotActivityAction })),
  event('vm.status', z.object({ vm: VmInfo })),
  event('provider.usage', z.object({ usage: CliUsage })),
  /** Config, tools or connection state. */
  event('mcp.server.updated', z.object({ server: McpServer })),
  event('mcp.server.deleted', z.object({ serverId: z.string() })),
  event('procedure.updated', z.object({ procedure: Procedure })),
  event('procedure.deleted', z.object({ procedureId: z.string() })),
  event('skill.updated', z.object({ skill: Skill })),
  event('skill.deleted', z.object({ skillId: z.string() })),
  /** Frames without HTML. */
  event('design.updated', z.object({ design: Design })),
  event('design.frame.updated', z.object({ designId: z.string(), frame: DesignFrame, deleted: z.boolean() })),
  event('design.deleted', z.object({ designId: z.string() })),
  /**
   * A frame a bot is still writing (`design_write_frame` input as it streams) or a drawing being drawn into an
   * art frame (`frameId`, draft id `art:<frameId>`): the partial page compiled, where the frame goes and the
   * frame it replaces. Repeated as it grows, same `draftId`.
   */
  event(
    'design.frame.draft',
    z.object({
      designId: z.string(),
      draftId: z.string(),
      botId: z.string(),
      frameId: z.string().nullable(),
      name: z.string(),
      x: z.number(),
      y: z.number(),
      width: z.number(),
      /** null: grows with the content. */
      height: z.number().nullable(),
      theme: z.string(),
      html: z.string(),
      /** `design_draw`: `pen` in frame pixels. */
      art: z.object({ pen: z.object({ x: z.number(), y: z.number() }).nullable() }).optional(),
    }),
  ),
  /** The frame was written (or the write failed) or the turn ended. */
  event('design.frame.draft.cleared', z.object({ designId: z.string(), draftId: z.string() })),
  /**
   * A bot started (`active`) or finished changing (`write`) or reading (`read`) a design; `frameId`: the frame
   * it is drawing or reading.
   */
  event(
    'design.presence',
    z.object({
      designId: z.string(),
      frameId: z.string().nullable(),
      botId: z.string(),
      active: z.boolean(),
      mode: z.enum(['write', 'read']).default('write'),
    }),
  ),
  event('routine.updated', z.object({ routine: Routine })),
  event('routine.deleted', z.object({ routineId: z.string(), botId: z.string() })),
  /** The bot's set-aside requests changed (one added, woken or dropped). */
  event('set_aside.changed', z.object({ botId: z.string() })),
  event('board.updated', z.object({ board: Board })),
  /** Every card of the board, in order. */
  event('board.cards.updated', z.object({ boardId: z.string(), cards: z.array(BoardCard) })),
  event('board.deleted', z.object({ boardId: z.string() })),
  event('project.updated', z.object({ project: Project })),
  event('project.deleted', z.object({ projectId: z.string() })),
  event('plan.updated', z.object({ plan: Plan })),
  event('plan.deleted', z.object({ planId: z.string() })),
  event('work_session.updated', z.object({ session: WorkSession })),
  event('work_session.deleted', z.object({ sessionId: z.string() })),
  event('work_session.files_changed', z.object({ sessionId: z.string(), totals: SessionChangeTotals })),
  /** An LLM call was recorded, or a running one (`LLM_CALL_RUNNING`) moved on or ended: the debug panel reloads. */
  event(
    'llm_call.recorded',
    z.object({ callId: z.string(), conversationId: z.string().nullable(), turnId: z.string().nullable() }),
  ),
  event('attachment.updated', z.object({ attachment: Attachment })),
  event('backup.job', z.object({ job: BackupJob })),
  event('backup.restore', z.object({ restore: BackupRestore })),
  event('knowledge.doc.updated', z.object({ doc: KnowledgeDoc })),
  event('knowledge.doc.deleted', z.object({ docId: z.string() })),
  event('knowledge.index.status', z.object({ status: KnowledgeIndexStatus })),
  event('office.status', z.object({ status: OfficeStatus })),
  /** E.g. the "started teaching" line of a discarded recording. */
  event('message.deleted', z.object({ conversationId: z.string(), messageId: z.string() })),
  /** Drives notifications (replies to the user, routine runs). */
  event(
    'turn.finished',
    z.object({
      botId: z.string(),
      conversationId: z.string(),
      turnId: z.string(),
      trigger: TurnTrigger,
      outcome: z.enum(['done', 'error', 'cancelled']),
      reply: z.string(),
      routine: z.object({ id: z.string(), name: z.string() }).nullable(),
    }),
  ),
])
export type WorkspaceEvent = z.infer<typeof WorkspaceEvent>

function envelope<E extends z.ZodType>(eventSchema: E) {
  return z.object({
    seq: z.number().int().nonnegative(),
    at: z.number().int(),
    workspaceId: z.string().nullable(),
    event: eventSchema,
  })
}

export const AppEventEnvelope = envelope(AppEvent)
export type AppEventEnvelope = z.infer<typeof AppEventEnvelope>
export const WorkspaceEventEnvelope = envelope(WorkspaceEvent)
export type WorkspaceEventEnvelope = z.infer<typeof WorkspaceEventEnvelope>

export const EVENTS_PATH = '/events'
export const WORKSPACE_EVENTS_PATH = '/w/:workspaceId/events'
