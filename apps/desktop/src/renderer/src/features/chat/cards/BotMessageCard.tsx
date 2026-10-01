import type { Bot, BotMessageReceivedPayload, BotMessageSentPayload } from '@milibot/shared'
import { ChevronRight } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { BotAvatar } from '@/features/bots/avatar/BotAvatar'

import { NoticeCard, NoticeLines } from './NoticeCard'

/** A message between two bots: sent (in the sender's chat, `other` = target) or received (`other` = sender). */
export function BotMessageCard({
  payload,
  other,
  onOpen,
}: {
  payload: BotMessageSentPayload | BotMessageReceivedPayload
  other: Bot | undefined
  onOpen?: () => void
}) {
  const { t } = useTranslation()
  const status = payload.status
  const name = other?.name ?? '…'
  return (
    <NoticeCard
      tone="accent"
      icon={other && <BotAvatar avatar={other.avatar} state={other.status} size={24} className="shrink-0" />}
      actions={
        onOpen && (
          <button
            type="button"
            onClick={onOpen}
            className="focus-ring flex shrink-0 items-center gap-1 rounded text-sm text-accent hover:underline"
          >
            {t('chat.botMessage.open')}
            <ChevronRight size={13} />
          </button>
        )
      }
    >
      <NoticeLines>
        <span className="text-sm font-semibold text-accent">
          {payload.type === 'bot_message_sent'
            ? t('chat.botMessage.sentTo', { name })
            : t('chat.botMessage.receivedFrom', { name })}
          {status !== 'timeout' && (
            <span className="font-normal text-fg-muted">
              {' · '}
              {payload.type === 'bot_message_sent'
                ? t(
                    payload.notice && status === 'waiting'
                      ? 'chat.botMessage.notice'
                      : `chat.botMessage.${status}`,
                  )
                : t(`chat.botMessage.received.${status}`)}
            </span>
          )}
        </span>
        <span className="line-clamp-2 text-sm leading-[15px] text-fg-secondary">“{payload.preview}”</span>
      </NoticeLines>
    </NoticeCard>
  )
}
