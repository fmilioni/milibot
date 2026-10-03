import {
  ActivityPayload,
  BoardPayload,
  BotMessageReceivedPayload,
  BotMessageSentPayload,
  ConfirmationPayload,
  DesignPayload,
  ErrorPayload,
  GeneratedImagesPayload,
  McpSignInPayload,
  type Message,
  type MessageAttachment,
  PlanPayload,
  ProcedureSavedPayload,
  PromptUpdatedPayload,
  QuestionPayload,
  RoutineCreatedPayload,
  RoutineRunPayload,
  SecretRequestPayload,
  SessionBriefPayload,
  SkillCreatedPayload,
  SpendWarningPayload,
  SystemPayload,
  TaskPayload,
  TextPayload,
  WorkSessionPayload,
} from '@milibot/shared'
import type { z } from 'zod'

export { RoutineCreatedPayload, SpendWarningPayload }

export type MessageView =
  | {
      type: 'text'
      streaming: boolean
      attachments: MessageAttachment[]
      /** Shown instead of `content` (which adds lines only for the models). */
      text: string | null
    }
  | { type: 'activity'; payload: ActivityPayload }
  | { type: 'bot_message_sent'; payload: BotMessageSentPayload }
  | { type: 'bot_message_received'; payload: BotMessageReceivedPayload }
  | { type: 'confirmation'; payload: ConfirmationPayload }
  | { type: 'error'; payload: ErrorPayload }
  | { type: 'procedure_saved'; payload: ProcedureSavedPayload }
  | { type: 'skill_created'; payload: SkillCreatedPayload }
  | { type: 'prompt_updated'; payload: PromptUpdatedPayload }
  | { type: 'system'; payload: SystemPayload | null }
  | { type: 'task'; payload: TaskPayload }
  | { type: 'routine_created'; payload: RoutineCreatedPayload }
  | { type: 'routine_run'; payload: RoutineRunPayload }
  | { type: 'spend_warning'; payload: z.infer<typeof SpendWarningPayload> }
  | { type: 'secret_request'; payload: SecretRequestPayload }
  | { type: 'question'; payload: QuestionPayload }
  | { type: 'plan'; payload: PlanPayload }
  | { type: 'work_session'; payload: WorkSessionPayload }
  | { type: 'session_brief'; payload: SessionBriefPayload }
  | { type: 'design'; payload: DesignPayload }
  | { type: 'board'; payload: BoardPayload }
  | { type: 'generated_images'; payload: GeneratedImagesPayload }
  | { type: 'mcp_sign_in'; payload: McpSignInPayload }

const CARD_PARSERS = [
  ['activity', ActivityPayload],
  ['bot_message_sent', BotMessageSentPayload],
  ['bot_message_received', BotMessageReceivedPayload],
  ['confirmation', ConfirmationPayload],
  ['error', ErrorPayload],
  ['procedure_saved', ProcedureSavedPayload],
  ['skill_created', SkillCreatedPayload],
  ['prompt_updated', PromptUpdatedPayload],
  ['task', TaskPayload],
  ['routine_created', RoutineCreatedPayload],
  ['routine_run', RoutineRunPayload],
  ['spend_warning', SpendWarningPayload],
  ['secret_request', SecretRequestPayload],
  ['question', QuestionPayload],
  ['plan', PlanPayload],
  ['work_session', WorkSessionPayload],
  ['session_brief', SessionBriefPayload],
  ['design', DesignPayload],
  ['board', BoardPayload],
  ['generated_images', GeneratedImagesPayload],
  ['mcp_sign_in', McpSignInPayload],
] as const

/** Picks the renderer for a message; anything unknown degrades to its plain-text `content`. */
export function toMessageView(message: Message): MessageView {
  const payload = message.payload as { type?: unknown } | null
  if (message.kind === 'system_event' || message.authorType === 'system') {
    const parsed = SystemPayload.safeParse(payload)
    if (parsed.success) return { type: 'system', payload: parsed.data }
  }
  if (payload && typeof payload.type === 'string') {
    for (const [type, schema] of CARD_PARSERS) {
      if (payload.type !== type) continue
      const parsed = schema.safeParse(payload)
      if (!parsed.success) continue
      return { type, payload: parsed.data } as MessageView
    }
  }
  if (message.kind === 'system_event' || message.authorType === 'system')
    return { type: 'system', payload: null }
  const text = TextPayload.safeParse(payload)
  if (!text.success) return { type: 'text', streaming: false, attachments: [], text: null }
  return {
    type: 'text',
    streaming: text.data.streaming,
    attachments: text.data.attachments ?? [],
    text: text.data.text ?? null,
  }
}
