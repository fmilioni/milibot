import type { Bot } from '@milibot/shared'
import { PenTool } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { BotAvatar } from '@/features/bots/avatar/BotAvatar'
import { isBusyStatus } from '@/features/bots/lib/bot-status'
import { useDesignStore } from '@/features/canvas/store'
import { screenIs, toastOnError, useAppStore } from '@/features/workspace/store'
import { useNow } from '@/hooks/use-now'

/** A presence older than this no longer means the bot is on that design. */
const RECENT_MS = 2 * 60_000

/**
 * Above the composer while a bot of the conversation works on a design, so the user doesn't scroll up to the
 * design's card.
 */
export function DesignPresenceChip({ conversationId, members }: { conversationId: string; members: Bot[] }) {
  const { t } = useTranslation()
  const presence = useDesignStore((s) => s.presence)
  const designs = useDesignStore((s) => s.designs)
  const openCanvas = useAppStore((s) => s.openCanvas)
  const openDesignId = useAppStore((s) => screenIs(s.screen, 'canvas')?.designId ?? null)
  const now = useNow(10_000)
  const editing = members
    .filter((bot) => isBusyStatus(bot.status))
    .flatMap((bot) =>
      Object.entries(presence).flatMap(([designId, byBot]) => {
        const p = byBot?.[bot.id]
        const design = designs[designId]
        return p && design && p.mode === 'write' && now - p.at < RECENT_MS ? [{ bot, design, at: p.at }] : []
      }),
    )
    .sort((a, b) => b.at - a.at)[0]
  if (!editing || editing.design.id === openDesignId) return null
  return (
    <div className="shrink-0 px-5 pb-1.5">
      <div className="mx-auto flex w-full max-w-[816px]">
        <div className="flex min-w-0 items-center gap-2 rounded-full border border-border bg-surface px-2.5 py-1 text-sm">
          <BotAvatar avatar={editing.bot.avatar} state={editing.bot.status} size={16} className="shrink-0" />
          <PenTool size={12} className="shrink-0 text-fg-muted" aria-hidden />
          <span className="min-w-0 truncate text-fg-secondary">
            {t('chat.designPresence', { name: editing.bot.name, design: editing.design.name })}
          </span>
          <button
            type="button"
            onClick={() => void toastOnError(openCanvas(editing.design.id, conversationId))}
            className="focus-ring shrink-0 rounded font-medium text-accent hover:underline"
          >
            {t('chat.designPresenceOpen')}
          </button>
        </div>
      </div>
    </div>
  )
}
