import { ApiError, type Bot, type Message } from '@milibot/shared'
import type { ReactNode } from 'react'

import { BoardChatCard } from '@/features/boards/BoardChatCard'
import { undoPromptVersion } from '@/features/bots/api'
import { BotMessageCard } from '@/features/chat/cards/BotMessageCard'
import { ConfirmationCard } from '@/features/chat/cards/ConfirmationCard'
import { ErrorCard } from '@/features/chat/cards/ErrorCard'
import { GeneratedImagesCard } from '@/features/chat/cards/GeneratedImagesCard'
import { McpSignInCard } from '@/features/chat/cards/McpCards'
import { PlanCard } from '@/features/chat/cards/PlanCard'
import { ProcedureSavedCard } from '@/features/chat/cards/ProcedureSavedCard'
import { PromptUpdatedCard } from '@/features/chat/cards/PromptCards'
import { QuestionCard } from '@/features/chat/cards/QuestionCard'
import { RoutineCard } from '@/features/chat/cards/RoutineCard'
import { RoutineRunCard } from '@/features/chat/cards/RoutineRunCard'
import { SecretRequestCard } from '@/features/chat/cards/SecretRequestCard'
import { SessionBriefCard, WorkSessionCard, WorkSessionStartedRow } from '@/features/chat/cards/SessionCards'
import { SkillCreatedEntry } from '@/features/chat/cards/SkillCreatedCard'
import { SpendCard } from '@/features/chat/cards/SpendCard'
import { TaskCard } from '@/features/chat/cards/TaskCard'
import { loginEngineOf } from '@/features/chat/lib/error-text'
import { splitInlineImages } from '@/features/chat/lib/inline-images'
import type { MessageView } from '@/features/chat/lib/message-view'
import { DesignCard } from '@/features/designs/DesignCard'
import { openCliLoginTerminal } from '@/features/providers/api'
import { sessionCardIsCompact } from '@/features/sessions/lib/session-view'
import { toastOnError, useAppStore } from '@/features/workspace/store'
import type { MentionTarget } from '@/lib/mentions'
import { Collapsible } from '@/ui/Collapsible'

import { ActivityTurn } from './ActivityCard'
import { MessageAttachments } from './Attachments'
import { BotText } from './MessageRow'
import { SystemLine } from './SystemLine'

export interface MessageBodyContext {
  bots: Record<string, Bot>
  /** The message's author. */
  bot: Bot | undefined
  mentions: MentionTarget[]
  showRoleChips: boolean
  reduced: boolean
  /** Shown in the internal (bot↔bot) panel. */
  internal: boolean
}

/**
 * What a message shows, by its view type. `standalone` cards take the whole row (no author line); the
 * others go under the author's avatar and name.
 */
export function messageBody(
  view: MessageView,
  message: Message,
  ctx: MessageBodyContext,
): { node: ReactNode; standalone: boolean } {
  const store = useAppStore.getState
  const { bots } = ctx
  const standalone = (node: ReactNode) => ({ node, standalone: true })
  const body = (node: ReactNode) => ({ node, standalone: false })
  const declineRequest = (requestId: string) => toastOnError(store().declineUserRequest(requestId))

  switch (view.type) {
    case 'system':
      return standalone(<SystemLine payload={view.payload} fallback={message.content} bots={bots} />)
    case 'spend_warning':
      return standalone(
        <SpendCard
          payload={view.payload}
          onAdjust={() => store().openSettings('costs')}
          onResume={() => void store().resumeSpend()}
        />,
      )
    case 'routine_run':
      return standalone(<RoutineRunCard payload={view.payload} />)
    case 'session_brief':
      return standalone(<SessionBriefCard payload={view.payload} content={message.content} />)
    case 'procedure_saved':
      return standalone(
        <ProcedureSavedCard
          payload={view.payload}
          bots={bots}
          onOpen={() => store().openRightPanel('bot')}
        />,
      )
    case 'prompt_updated': {
      const { versionId } = view.payload
      return standalone(
        <PromptUpdatedCard
          payload={view.payload}
          bots={bots}
          onUndo={() =>
            undoPromptVersion(store().workspaceId ?? '', versionId)
              .then(() => undefined)
              .catch((err: unknown) =>
                store().showToast(
                  err instanceof ApiError && err.code === 'conflict' ? 'promptChanged' : 'error',
                ),
              )
          }
        />,
      )
    }
    case 'question': {
      const { requestId, status } = view.payload
      if (status !== 'pending' && status !== 'answered') {
        const noop = () => Promise.resolve()
        return standalone(
          <QuestionCard
            payload={view.payload}
            bot={bots[view.payload.botId]}
            onAnswer={noop}
            onDecline={noop}
          />,
        )
      }
      return body(
        <QuestionCard
          payload={view.payload}
          bot={bots[view.payload.botId]}
          onAnswer={(answers) => toastOnError(store().answerQuestion(requestId, answers))}
          onDecline={() => declineRequest(requestId)}
        />,
      )
    }
    case 'text': {
      const { inline, rest } = splitInlineImages(view.text ?? message.content, view.attachments)
      return body(
        <>
          {view.text !== '' && (
            <Collapsible enabled={!view.streaming} fade={ctx.internal ? 'from-surface-2' : 'from-bg'}>
              <BotText
                message={message}
                text={view.text ?? undefined}
                streaming={view.streaming}
                mentions={ctx.mentions}
                reduced={ctx.reduced}
                compact={ctx.internal}
                images={inline}
              />
            </Collapsible>
          )}
          {rest.length > 0 && (
            <div className={view.text === '' ? undefined : 'mt-2'}>
              <MessageAttachments attachments={rest} align="start" />
            </div>
          )}
        </>,
      )
    }
    case 'activity':
      return body(
        <ActivityTurn
          payload={view.payload}
          botId={message.authorBotId}
          conversationId={message.conversationId}
          mentions={ctx.mentions}
          compact={ctx.internal}
        />,
      )
    case 'bot_message_sent': {
      const internalId = view.payload.internalConversationId
      return body(
        <BotMessageCard
          payload={view.payload}
          other={bots[view.payload.targetBotId]}
          onOpen={internalId ? () => void store().openInternalConversation(internalId) : undefined}
        />,
      )
    }
    case 'bot_message_received': {
      const internalId = view.payload.internalConversationId
      return body(
        <BotMessageCard
          payload={view.payload}
          other={bots[view.payload.fromBotId]}
          onOpen={() => void store().openInternalConversation(internalId)}
        />,
      )
    }
    case 'confirmation': {
      const { confirmationId } = view.payload
      return body(
        <ConfirmationCard
          payload={view.payload}
          author={ctx.bot}
          onResolve={(approved) => toastOnError(store().resolveConfirmation(confirmationId, approved))}
        />,
      )
    }
    case 'secret_request': {
      const { requestId } = view.payload
      return body(
        <SecretRequestCard
          payload={view.payload}
          bot={bots[view.payload.botId]}
          onAnswer={(answer) => toastOnError(store().answerSecretRequest(requestId, answer))}
          onDecline={() => declineRequest(requestId)}
          onManage={() => store().openSettings('credentials')}
        />,
      )
    }
    case 'plan':
      return body(<PlanCard payload={view.payload} />)
    case 'design':
      return body(<DesignCard payload={view.payload} conversationId={message.conversationId} />)
    case 'board':
      return body(<BoardChatCard payload={view.payload} />)
    case 'generated_images':
      return body(<GeneratedImagesCard payload={view.payload} />)
    case 'work_session': {
      const { sessionId } = view.payload
      const onOpen = () => void toastOnError(store().openWorkSession(sessionId))
      return body(
        sessionCardIsCompact(view.payload, message.conversationId) ? (
          <WorkSessionStartedRow payload={view.payload} onOpen={onOpen} />
        ) : (
          <WorkSessionCard payload={view.payload} onOpen={onOpen} />
        ),
      )
    }
    case 'error': {
      const onOpenScreen = () => {
        const workspaceId = store().workspaceId
        const engine = loginEngineOf(view.payload)
        if (engine && workspaceId)
          void toastOnError(openCliLoginTerminal(workspaceId, engine, message.authorBotId))
        store().openRightPanel('vm')
      }
      return body(<ErrorCard payload={view.payload} onOpenScreen={onOpenScreen} />)
    }
    case 'task':
      return body(<TaskCard payload={view.payload} />)
    case 'mcp_sign_in':
      return body(<McpSignInCard payload={view.payload} />)
    case 'skill_created':
      return body(<SkillCreatedEntry payload={view.payload} bots={bots} />)
    case 'routine_created':
      return body(
        <RoutineCard payload={view.payload} onOpen={() => store().openRightPanel('bot', 'routines')} />,
      )
  }
}
