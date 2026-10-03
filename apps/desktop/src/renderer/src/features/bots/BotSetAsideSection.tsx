import type { Bot, SetAsideRequest } from '@milibot/shared'
import { Clock, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { queryKeys } from '@/api/queries'
import { dropSetAside, useBotSetAside } from '@/features/bots/api'
import { useAppStore } from '@/features/workspace/store'
import { useApiMutation } from '@/features/workspace/use-api-mutation'
import { formatRelative } from '@/lib/format'
import { Tooltip } from '@/ui/Tooltip'

/** Requests the bot set aside for when its current work ends and has not taken up yet (hidden when none). */
export function BotSetAsideSection({ bot }: { bot: Bot }) {
  const { t } = useTranslation()
  const workspaceId = useAppStore((s) => s.workspaceId)
  const requests = useBotSetAside(workspaceId, bot.id).data
  const { run: drop } = useApiMutation((id: string) => dropSetAside(workspaceId ?? '', id), {
    invalidates: workspaceId ? [queryKeys.setAside(workspaceId, bot.id)] : [],
  })
  if (!requests?.length) return null
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-sm font-medium text-fg-secondary">{t('panels.bot.setAside.title')}</h3>
      <ul className="flex flex-col gap-2">
        {requests.map((request) => (
          <SetAsideItem key={request.id} request={request} bot={bot} onDrop={() => void drop(request.id)} />
        ))}
      </ul>
      <span className="text-xs text-fg-muted">{t('panels.bot.setAside.hint', { name: bot.name })}</span>
    </section>
  )
}

function SetAsideItem({ request, bot, onDrop }: { request: SetAsideRequest; bot: Bot; onDrop: () => void }) {
  const { t, i18n } = useTranslation()
  const conversation = useAppStore((s) => s.conversations[request.conversationId])
  const bots = useAppStore((s) => s.bots)
  const selectConversation = useAppStore((s) => s.selectConversation)
  const other = conversation?.memberBotIds.find((id) => id !== bot.id)
  const where =
    conversation?.type === 'internal' && other && bots[other]
      ? t('panels.bot.setAside.withBot', { name: bots[other].name })
      : conversation?.type === 'group'
        ? (conversation.title ?? t('panels.bot.setAside.group'))
        : t('panels.bot.setAside.withUser')
  const since = formatRelative(request.createdAt, i18n.language)
  return (
    <li className="flex items-center gap-2.5 rounded-lg border border-border bg-surface-2 py-2.5 pr-2 pl-3">
      <Clock size={15} className="shrink-0 text-warning" />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <Tooltip content={request.task}>
          <span className="truncate text-base text-fg">{request.task}</span>
        </Tooltip>
        <span className="truncate text-xs text-fg-muted">
          {conversation ? (
            <button
              type="button"
              onClick={() => selectConversation(request.conversationId)}
              className="focus-ring rounded hover:text-fg hover:underline"
            >
              {where}
            </button>
          ) : (
            where
          )}
          {' · '}
          {t('panels.bot.setAside.since', { when: since })}
        </span>
      </span>
      <Tooltip content={t('panels.bot.setAside.drop')}>
        <button
          type="button"
          aria-label={t('panels.bot.setAside.drop')}
          onClick={onDrop}
          className="focus-ring flex size-7 shrink-0 items-center justify-center rounded-md text-fg-muted hover:bg-surface-3 hover:text-fg"
        >
          <X size={14} />
        </button>
      </Tooltip>
    </li>
  )
}
