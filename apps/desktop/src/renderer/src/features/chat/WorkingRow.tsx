import type { Bot } from '@milibot/shared'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { BotAvatar } from '@/features/bots/avatar/BotAvatar'
import { botStatusLabel, isBusyStatus, statusActivity } from '@/features/bots/lib/bot-status'
import { openDesignFor } from '@/features/canvas/store'
import { toastOnError, useAppStore } from '@/features/workspace/store'
import { cn } from '@/lib/cn'
import { Spinner } from '@/ui/Spinner'

/** "Working…" row under the last message while a bot works on the reply. */
export function WorkingRow({ bot, showName, reduced }: { bot: Bot; showName: boolean; reduced: boolean }) {
  const { t } = useTranslation()
  return (
    <div className="flex items-center gap-3" data-working-row aria-hidden>
      <BotAvatar
        avatar={bot.avatar}
        state={isBusyStatus(bot.status) ? bot.status : 'thinking'}
        size={28}
        className="shrink-0"
      />
      <div className="flex min-w-0 items-baseline gap-1.5 text-base leading-5">
        {showName && <span className="font-semibold text-fg">{bot.name}</span>}
        <span className="text-fg-secondary">
          {t('chat.working')}
          {reduced ? (
            '…'
          ) : (
            <span className="working-dots">
              <span>.</span>
              <span>.</span>
              <span>.</span>
            </span>
          )}
        </span>
      </div>
    </div>
  )
}

/** A paused bot the user wrote to: it answers once resumed. */
export function PausedRow({ bot }: { bot: Bot }) {
  const { t } = useTranslation()
  const controlBot = useAppStore((s) => s.controlBot)
  const showToast = useAppStore((s) => s.showToast)
  const [resuming, setResuming] = useState(false)
  const resume = async () => {
    setResuming(true)
    try {
      await controlBot(bot.id, 'resume')
    } catch {
      showToast('error')
    } finally {
      setResuming(false)
    }
  }
  return (
    <div className="flex items-center gap-3" data-paused-row>
      <BotAvatar avatar={bot.avatar} state="paused" size={28} className="shrink-0" />
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-1.5 text-base leading-5">
        <span className="text-fg-secondary">{t('chat.pausedWaiting', { name: bot.name })}</span>
        <button
          type="button"
          disabled={resuming}
          onClick={() => void resume()}
          className="focus-ring rounded font-medium text-accent hover:underline disabled:opacity-60"
        >
          {t('chat.resume')}
        </button>
      </div>
    </div>
  )
}

/** "Working" row of the internal panel: what the bot is doing, with a shortcut to its screen or design. */
export function InternalWorkingRow({
  bot,
  right,
  bots,
}: {
  bot: Bot
  right: boolean
  bots: Record<string, Bot>
}) {
  const { t } = useTranslation()
  const conversationId = useAppStore((s) => s.selectedConversationId)
  const detail = useAppStore((s) => s.statusDetail[bot.id])
  const showScreen = useAppStore((s) => s.showBotScreen)
  const activity = isBusyStatus(bot.status) ? bot.status : 'thinking'
  const doing = statusActivity(detail?.detail)
  const watch =
    doing === 'computer' || doing === 'browser'
      ? { label: t('chat.activity.showScreen'), onClick: () => showScreen(bot.id) }
      : doing === 'design'
        ? {
            label: t('chat.activity.showDesign'),
            onClick: () => conversationId && void toastOnError(openDesignFor(conversationId, bot.id, null)),
          }
        : null
  return (
    <div className={cn('flex items-center gap-2.5', right && 'flex-row-reverse')} data-working-row>
      <BotAvatar avatar={bot.avatar} state={activity} size={26} className="shrink-0" />
      <div className="flex max-w-[85%] min-w-0 items-center gap-2 rounded-[10px] border border-border bg-surface-2 px-3 py-2">
        <Spinner size={13} className="text-success" />
        <span className="min-w-0 truncate text-sm text-fg-secondary">
          {t('panels.internal.working', {
            name: bot.name,
            activity: botStatusLabel(activity, detail, t, bots),
          })}
        </span>
        {watch && (
          <button
            type="button"
            onClick={watch.onClick}
            className="focus-ring shrink-0 rounded text-sm text-accent hover:underline"
          >
            {watch.label}
          </button>
        )}
      </div>
    </div>
  )
}
