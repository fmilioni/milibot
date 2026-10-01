import type { Bot } from '@milibot/shared'
import { Info, Lock, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { BotAvatar } from '@/features/bots/avatar/BotAvatar'
import { useAppStore } from '@/features/workspace/store'
import { formatClock } from '@/lib/format'
import { Tooltip } from '@/ui/Tooltip'

import { MessageList } from './MessageList'

/** Read-only bot↔bot conversation (ask_bot / message_bot), opened from "View conversation". */
export function InternalPanel() {
  const { t, i18n } = useTranslation()
  const conversationId = useAppStore((s) => s.internalConversationId)
  const conversation = useAppStore((s) => (conversationId ? s.conversations[conversationId] : undefined))
  const firstMessage = useAppStore((s) => (conversationId ? s.threads[conversationId]?.items[0] : undefined))
  const lastAuthor = useAppStore((s) =>
    conversationId
      ? s.threads[conversationId]?.items.findLast((m) => m.kind === 'text' && m.authorBotId)?.authorBotId
      : undefined,
  )
  const bots = useAppStore((s) => s.bots)
  const close = useAppStore((s) => s.toggleRightPanel)

  const members = conversation?.memberBotIds.flatMap((id) => bots[id] ?? []) ?? []
  const asker = (firstMessage?.authorBotId && bots[firstMessage.authorBotId]) || members[0]
  const target = members.find((b) => b.id !== asker?.id)

  return (
    <>
      <header className="drag-region flex h-16 shrink-0 items-center gap-3 border-b border-border px-4 win:pr-caption-4">
        {asker && target ? <PairAvatar a={asker} b={target} /> : null}
        <div className="flex min-w-0 flex-1 flex-col gap-[3px]">
          <h2 className="truncate text-lg leading-[18px] font-semibold text-fg">
            {asker && target ? t('panels.internal.title', { a: asker.name, b: target.name }) : '…'}
          </h2>
          {asker && firstMessage && (
            <span className="truncate text-sm leading-4 text-fg-secondary">
              {t('panels.internal.startedBy', {
                name: asker.name,
                time: formatClock(firstMessage.createdAt, i18n.language),
              })}
            </span>
          )}
        </div>
        <Tooltip content={t('panels.close')}>
          <button
            type="button"
            onClick={() => close('internal')}
            aria-label={t('panels.close')}
            className="no-drag focus-ring shrink-0 rounded text-fg-muted hover:text-fg"
          >
            <X size={15} />
          </button>
        </Tooltip>
      </header>
      {conversation ? (
        <>
          <div className="flex shrink-0 items-center gap-2 border-b border-border bg-accent-soft px-4 py-2 text-sm text-accent">
            <Lock size={13} className="shrink-0" />
            {t('panels.internal.readOnly')}
          </div>
          <MessageList
            conversationId={conversation.id}
            bots={bots}
            emptyName={target?.name ?? ''}
            emptyBot={target ?? null}
            showRoleChips={false}
            internal={{ rightBotId: asker?.id ?? null }}
          />
          {asker && target && lastAuthor === asker.id && (
            <div className="flex shrink-0 items-center gap-2 border-t border-border px-4 py-3 text-sm text-fg-muted">
              <Info size={13} className="shrink-0" />
              {t('panels.internal.footer', { target: target.name, asker: asker.name })}
            </div>
          )}
        </>
      ) : (
        <div className="flex flex-1 items-center justify-center p-10 text-center text-base text-fg-muted">
          {t('panels.internal.empty')}
        </div>
      )}
    </>
  )
}

function PairAvatar({ a, b }: { a: Bot; b: Bot }) {
  return (
    <div className="relative h-7 w-11 shrink-0">
      <BotAvatar avatar={a.avatar} state={a.status} size={26} className="absolute top-0 left-0" />
      <BotAvatar avatar={b.avatar} state={b.status} size={26} className="absolute top-0.5 left-[18px]" />
    </div>
  )
}
