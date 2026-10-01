import { type ConversationSummary, firstBot } from '@milibot/shared'
import { ArrowUpRight, CalendarClock, GitPullRequest, Search, Wallet } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { STARTER_SUGGESTIONS, type StarterSuggestion } from '@/features/setup/lib/setup'
import { useAppStore } from '@/features/workspace/store'

import { CHAT_COLUMN } from './MessageList'

const ICONS: Record<StarterSuggestion, typeof Wallet> = {
  finances: Wallet,
  repos: GitPullRequest,
  research: Search,
  news: CalendarClock,
}

/**
 * Under the first bot's introduction, ideas that send themselves when clicked. Shown while the user has not
 * written in its DM yet.
 */
export function StarterSuggestions({ conversation }: { conversation: ConversationSummary }) {
  const { t } = useTranslation()
  const bots = useAppStore((s) => s.bots)
  const thread = useAppStore((s) => s.threads[conversation.id])
  const sendMessage = useAppStore((s) => s.sendMessage)
  const [sending, setSending] = useState(false)
  const bot = conversation.type === 'direct' ? bots[conversation.memberBotIds[0] ?? ''] : undefined
  if (!bot || bot.id !== firstBot(Object.values(bots))?.id || !thread || thread.loading || thread.hasMore)
    return null
  const items = thread.items
  if (items.length === 0 || items.some((m) => m.authorType === 'user')) return null
  const last = items.at(-1)
  const streaming =
    last?.payload && typeof last.payload === 'object' && 'streaming' in last.payload && last.payload.streaming
  if (streaming || bot.status !== 'idle') return null

  return (
    <div className="px-7 pb-3">
      <div className={CHAT_COLUMN}>
        <ul aria-label={t('setup.suggestions.label')} className="flex flex-col gap-1.5 pl-10">
          {STARTER_SUGGESTIONS.map((key) => {
            const Icon = ICONS[key]
            const text = t(`setup.suggestions.${key}`)
            return (
              <li key={key}>
                <button
                  type="button"
                  disabled={sending}
                  onClick={() => {
                    setSending(true)
                    void sendMessage(conversation.id, text).finally(() => setSending(false))
                  }}
                  className="group flex w-full items-center gap-2.5 rounded-[9px] border border-border outline-none focus-visible:border-accent bg-surface-2 px-3 py-2 text-left text-base text-fg hover:border-accent/50 hover:bg-accent-soft disabled:opacity-60"
                >
                  <Icon size={14} className="shrink-0 text-accent" aria-hidden />
                  <span className="min-w-0 flex-1">{text}</span>
                  <ArrowUpRight
                    size={13}
                    className="shrink-0 text-fg-muted group-hover:text-accent"
                    aria-hidden
                  />
                </button>
              </li>
            )
          })}
        </ul>
      </div>
    </div>
  )
}
