import type { Bot, QuestionAnswer, QuestionPayload } from '@milibot/shared'
import { Check, MessageSquareReply, PencilLine, TimerOff, X } from 'lucide-react'
import { type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

import { BotAvatar } from '@/features/bots/avatar/BotAvatar'
import { followedRecommendation } from '@/features/chat/lib/question-card'

import { PendingQuestions } from './PendingQuestions'

/** `ask_user` card: questions with options and "Other answer"; answered/dismissed states are compact. */
export function QuestionCard({
  payload,
  bot,
  onAnswer,
  onDecline,
}: {
  payload: QuestionPayload
  bot: Bot | undefined
  onAnswer: (answers: QuestionAnswer[]) => Promise<void>
  onDecline: () => Promise<void>
}) {
  const { t } = useTranslation()
  const name = bot?.name ?? '…'
  switch (payload.status) {
    case 'pending':
      return <PendingQuestions payload={payload} bot={bot} onAnswer={onAnswer} onDecline={onDecline} />
    case 'answered':
      return <AnsweredQuestions payload={payload} bot={bot} />
    case 'answered_in_chat':
      return (
        <QuestionLine icon={<MessageSquareReply size={12} />}>
          {t('chat.question.answeredInChat', { name })}
        </QuestionLine>
      )
    case 'declined':
      return <QuestionLine icon={<X size={12} />}>{t('chat.question.declined', { name })}</QuestionLine>
    case 'expired':
      return (
        <QuestionLine icon={<TimerOff size={12} />}>
          {t(`chat.question.expired_${payload.expiredReason ?? 'stopped'}`, { name })}
        </QuestionLine>
      )
  }
}

function QuestionLine({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <div className="flex items-center justify-center gap-1.5 px-6 text-center text-sm text-fg-muted">
      <span className="shrink-0" aria-hidden>
        {icon}
      </span>
      <span>{children}</span>
    </div>
  )
}

function AnsweredQuestions({ payload, bot }: { payload: QuestionPayload; bot: Bot | undefined }) {
  const { t } = useTranslation()
  return (
    <div className="flex flex-col gap-2.5 rounded-[10px] border border-border bg-surface-2 px-4 py-3">
      <div className="flex items-center gap-2">
        {bot && <BotAvatar avatar={bot.avatar} size={18} animated={false} className="shrink-0" />}
        <span className="text-base font-semibold text-fg-secondary">
          {t('chat.question.answeredTitle', { name: bot?.name ?? '…' })}
        </span>
      </div>
      {payload.questions.map((question, index) => {
        const answer = payload.answers?.[index]
        const other = answer?.other?.trim()
        const chosen = answer?.selected.join(', ') ?? ''
        const text = other ? (chosen ? `${chosen} + “${other}”` : `“${other}”`) : chosen
        const recommended = followedRecommendation(question, answer)
        const Icon = other ? PencilLine : Check
        return (
          <div key={index} className="flex flex-col gap-[3px]">
            <p className="selectable text-sm text-fg-secondary">{question.question}</p>
            <p className="flex items-start gap-1.5">
              <Icon size={12} className="mt-[3px] shrink-0 text-accent" aria-hidden />
              <span className="selectable text-base font-semibold break-words text-fg">
                {text || '—'}
                {recommended && ` · ${t('chat.question.recommendedMark')}`}
              </span>
            </p>
          </div>
        )
      })}
    </div>
  )
}
