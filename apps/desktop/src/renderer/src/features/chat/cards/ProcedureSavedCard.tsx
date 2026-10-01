import type { Bot, ProcedureSavedPayload } from '@milibot/shared'
import { GraduationCap } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { NoticeCard, NoticeLines } from './NoticeCard'

/** "Procedure saved: <name>" after a recording made with "Teach" was written up. */
export function ProcedureSavedCard({
  payload,
  bots,
  onOpen,
}: {
  payload: ProcedureSavedPayload
  bots: Record<string, Bot>
  onOpen?: () => void
}) {
  const { t } = useTranslation()
  const botName = payload.botId ? bots[payload.botId]?.name : undefined
  return (
    <NoticeCard
      tone="accent"
      icon={<GraduationCap size={14} className="shrink-0 text-accent" />}
      actions={
        onOpen && (
          <button
            type="button"
            onClick={onOpen}
            className="focus-ring shrink-0 rounded text-sm text-accent hover:underline"
          >
            {t('chat.procedure.view')}
          </button>
        )
      }
    >
      <NoticeLines>
        <span className="truncate text-base font-semibold text-accent">
          {t('chat.procedure.saved', { name: payload.name })}
        </span>
        <span className="truncate text-sm text-fg-secondary">
          {t('chat.procedure.steps', { count: payload.steps })} ·{' '}
          {payload.scope === 'global'
            ? t('chat.procedure.scopeGlobal')
            : t('chat.procedure.scopeBot', { name: botName ?? '…' })}
        </span>
      </NoticeLines>
    </NoticeCard>
  )
}
