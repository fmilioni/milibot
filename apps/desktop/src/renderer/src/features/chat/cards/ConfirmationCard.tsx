import type { Bot, ConfirmationPayload } from '@milibot/shared'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { BotAvatar } from '@/features/bots/avatar/BotAvatar'
import { cn } from '@/lib/cn'
import { Button } from '@/ui/Button'
import { Tooltip } from '@/ui/Tooltip'

import { McpChangeDetails } from './McpCards'
import { ProposedPromptDiff } from './PromptCards'

export function ConfirmationCard({
  payload,
  author,
  onResolve,
}: {
  payload: ConfirmationPayload
  author: Bot | undefined
  onResolve?: (approved: boolean) => void | Promise<void>
}) {
  const { t } = useTranslation()
  const [busy, setBusy] = useState(false)
  const reason = payload.description.replace(/\s*\n\s*/g, ' ').trim()
  const pending = payload.status === 'pending'
  const mild =
    payload.action === 'update_prompt' ||
    payload.action === 'continue_bot_exchange' ||
    payload.action === 'mcp_add' ||
    payload.action === 'mcp_update'
  const action =
    payload.action === 'update_prompt' && author && payload.params?.botId === author.id
      ? 'update_prompt_own'
      : payload.action
  const resolve = (approved: boolean) => {
    if (!onResolve || busy) return
    setBusy(true)
    void Promise.resolve(onResolve(approved)).finally(() => setBusy(false))
  }
  return (
    <div
      className={cn(
        'flex flex-col gap-2.5 rounded-[10px] border bg-surface-2 p-3.5',
        mild ? 'border-border' : 'border-danger-soft',
      )}
    >
      <div className="flex items-center gap-2">
        {author && <BotAvatar avatar={author.avatar} size={18} animated={false} className="shrink-0" />}
        <span className="text-base font-semibold text-fg">
          {t(`chat.confirmation.actions.${action}`, {
            name: author?.name ?? '',
            botName: payload.params?.botName ?? '',
            groupName: payload.params?.groupName ?? '',
            serverName: payload.params?.serverName ?? '',
            defaultValue: t('chat.confirmation.generic', { name: author?.name ?? '' }),
          })}
        </span>
      </div>
      {reason && <p className="text-sm text-fg-secondary">“{reason}”</p>}
      {payload.action === 'update_prompt' && payload.params?.diff && (
        <ProposedPromptDiff
          diff={payload.params.diff}
          added={Number(payload.params.added ?? 0)}
          removed={Number(payload.params.removed ?? 0)}
        />
      )}
      {payload.action.startsWith('mcp_') && payload.params?.details && (
        <McpChangeDetails details={payload.params.details} />
      )}
      {pending ? (
        <div className="flex gap-2">
          <Tooltip content={onResolve ? null : t('chat.confirmation.cannotResolve')}>
            <Button size="sm" disabled={!onResolve || busy} onClick={() => resolve(false)}>
              {t(`chat.confirmation.rejectActions.${payload.action}`, {
                defaultValue: t('chat.confirmation.keep'),
              })}
            </Button>
          </Tooltip>
          <Tooltip content={onResolve ? null : t('chat.confirmation.cannotResolve')}>
            <Button
              size="sm"
              variant={mild ? 'primary' : 'danger'}
              disabled={!onResolve || busy}
              onClick={() => resolve(true)}
            >
              {t(`chat.confirmation.approveActions.${payload.action}`, {
                defaultValue: t('chat.confirmation.approve'),
              })}
            </Button>
          </Tooltip>
        </div>
      ) : (
        <span className="text-sm font-medium text-fg-muted">
          {t(`chat.confirmation.statusActions.${payload.action}.${payload.status}`, {
            defaultValue: t(`chat.confirmation.status.${payload.status}`),
          })}
        </span>
      )}
    </div>
  )
}
