import type { Bot, Message, QuestionPayload, SecretRequestPayload, SystemPayload } from '@milibot/shared'
import type { TFunction } from 'i18next'

import { splitFrameContext } from '@/features/canvas/lib/canvas'
import { appLanguage } from '@/i18n'
import { formatUsd } from '@/lib/format'

import { errorTitle } from './error-text'
import { toMessageView } from './message-view'

/** Markdown source flattened to one line of plain text (no markers, code blocks or link targets). */
export function markdownToPlainText(source: string): string {
  return source
    .replace(/```[^\n]*\n?([\s\S]*?)(```|$)/g, ' $1 ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__|~~)(.+?)\1/g, '$2')
    .replace(/^\s{0,3}(#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+|\|)/gm, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Localized text of a system line (`chat.systemEvents.<event>`, with a `_user` variant for the user's actions). */
export function systemEventText(
  payload: SystemPayload,
  fallback: string,
  bots: Record<string, Bot>,
  t: TFunction,
): string {
  const params = Object.fromEntries(
    Object.entries(payload.params).map(([k, v]) => [k, v === null ? '' : String(v)]),
  )
  const bot = payload.botId ? bots[payload.botId] : undefined
  const context =
    payload.event === 'session_rotated' && params.reason
      ? params.reason
      : payload.event === 'teach_started' && !params.procedureName
        ? 'unnamed'
        : payload.event === 'project_changed' && !params.projectName
          ? params.actor === 'user'
            ? 'cleared_user'
            : 'cleared'
          : params.actor === 'user'
            ? 'user'
            : undefined
  return String(
    t(`chat.systemEvents.${payload.event}`, {
      ...params,
      ...(context ? { context } : {}),
      name: bot?.name ?? params.name ?? '',
      defaultValue: fallback,
    }),
  )
}

/** One-line, localized summary of a message for the sidebar. */
export function messagePreview(message: Message, t: TFunction, bots: Record<string, Bot>): string {
  const view = toMessageView(message)
  switch (view.type) {
    case 'activity':
      return t(
        `chat.activity.${view.payload.status === 'running' ? 'working' : view.payload.status === 'done' ? 'done' : view.payload.status === 'error' ? 'failed' : 'stopped'}`,
        {
          count: view.payload.steps.length,
        },
      )
    case 'bot_message_sent':
      return t('chat.botMessage.sentTo', { name: bots[view.payload.targetBotId]?.name ?? '…' })
    case 'bot_message_received':
      return t('chat.botMessage.receivedFrom', { name: bots[view.payload.fromBotId]?.name ?? '…' })
    case 'error':
      return errorTitle(t, view.payload)
    case 'task':
      return view.payload.title
    case 'plan':
      return t('plans.card.preview', { title: view.payload.title })
    case 'design':
      return t('chat.design.preview', { name: view.payload.name })
    case 'board':
      return t('chat.board.preview', { title: view.payload.title })
    case 'generated_images':
      return t('chat.generatedImages.preview', { count: view.payload.images.length })
    case 'work_session':
    case 'session_brief':
      return t('chat.session.brief', { title: view.payload.title })
    case 'routine_created':
      return t('chat.routine.created', { name: view.payload.name })
    case 'routine_run':
      return t('chat.routine.run', { name: view.payload.name })
    case 'procedure_saved':
      return t('chat.procedure.saved', { name: view.payload.name })
    case 'skill_created':
      return t(view.payload.updated ? 'chat.skill.updated' : 'chat.skill.created', {
        name: view.payload.name,
      })
    case 'prompt_updated': {
      const target = bots[view.payload.botId]?.name ?? '…'
      const author = view.payload.authorBotId ?? view.payload.botId
      return author === view.payload.botId
        ? t('chat.prompt.updatedOwn', { name: target })
        : t('chat.prompt.updatedOther', { name: bots[author]?.name ?? '…', botName: target })
    }
    case 'spend_warning': {
      const spent = formatUsd(view.payload.spentUsd, appLanguage())
      return view.payload.paused ? t('chat.spend.paused', { spent }) : t('chat.spend.warning', { spent })
    }
    case 'secret_request':
      return secretRequestPreview(view.payload, bots[view.payload.botId]?.name ?? '…', t)
    case 'question':
      return questionPreview(view.payload, bots[view.payload.botId]?.name ?? '…', t)
    case 'system':
      return view.payload ? systemEventText(view.payload, message.content, bots, t) : message.content
    case 'confirmation': {
      const author = message.authorBotId ? bots[message.authorBotId]?.name : undefined
      const own =
        view.payload.action === 'update_prompt' && view.payload.params?.botId === message.authorBotId
      return String(
        t(`chat.confirmation.actions.${own ? 'update_prompt_own' : view.payload.action}`, {
          name: author ?? '',
          botName: view.payload.params?.botName ?? '',
          groupName: view.payload.params?.groupName ?? '',
          defaultValue: message.content,
        }),
      )
    }
    case 'text': {
      if (view.text === null) return defaultPreview(message, t)
      const names = view.attachments.map((a) => a.name).join(', ')
      return (
        markdownToPlainText(view.text) ||
        t('chat.attachments.preview', { names, count: view.attachments.length })
      )
    }
    default:
      return defaultPreview(message, t)
  }
}

function defaultPreview(message: Message, t: TFunction): string {
  if (message.payload?.type === 'user_message') {
    const text = splitFrameContext(message.payload.text).text.replace(/\s+/g, ' ').trim()
    const names = message.payload.attachments.map((a) => a.name).join(', ')
    return text || t('chat.attachments.preview', { names, count: message.payload.attachments.length })
  }
  return message.authorType === 'bot'
    ? markdownToPlainText(message.content)
    : splitFrameContext(message.content).text.replace(/\s+/g, ' ').trim()
}

function secretRequestPreview(payload: SecretRequestPayload, name: string, t: TFunction): string {
  const kind = payload.asEnv ? 'env' : 'password'
  switch (payload.status) {
    case 'pending':
      return t(`chat.secretRequest.preview.pending_${kind}`, { name, label: payload.label })
    case 'answered':
      return payload.asEnv
        ? t('chat.secretRequest.sentEnv', { secret: payload.name })
        : t('chat.secretRequest.sentTitle', { name, label: payload.label })
    case 'declined':
      return t(`chat.secretRequest.declined_${kind}`, { name })
    case 'expired':
      return t(`chat.secretRequest.expired_${kind}`)
  }
}

function questionPreview(payload: QuestionPayload, name: string, t: TFunction): string {
  switch (payload.status) {
    case 'pending':
      return t('chat.question.preview.pending', {
        name,
        question: payload.questions[0]?.question ?? '',
        count: payload.questions.length,
      })
    case 'answered':
      return t('chat.question.answeredTitle', { name })
    case 'answered_in_chat':
      return t('chat.question.answeredInChat', { name })
    case 'declined':
      return t('chat.question.declined', { name })
    case 'expired':
      return t(`chat.question.expired_${payload.expiredReason ?? 'stopped'}`, { name })
  }
}
