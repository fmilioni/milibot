import { Gauge } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import type { SpendWarningPayload } from '@/features/chat/lib/message-view'
import { formatUsd } from '@/lib/format'

import { NoticeCard, NoticeText } from './NoticeCard'

export function SpendCard({
  payload,
  onAdjust,
  onResume,
}: {
  payload: SpendWarningPayload
  onAdjust?: () => void
  onResume?: () => void
}) {
  const { t, i18n } = useTranslation()
  const spent = formatUsd(payload.spentUsd, i18n.language)
  if (payload.paused) {
    return (
      <NoticeCard
        tone="danger"
        icon={<Gauge size={14} className="shrink-0 text-danger" />}
        actions={
          <>
            {onResume && (
              <button
                type="button"
                onClick={onResume}
                className="focus-ring shrink-0 rounded text-sm font-semibold text-danger hover:underline"
              >
                {t('chat.spend.resume')}
              </button>
            )}
            {onAdjust && (
              <button
                type="button"
                onClick={onAdjust}
                className="focus-ring shrink-0 rounded text-sm font-semibold text-fg-secondary hover:underline"
              >
                {t('chat.spend.adjust')}
              </button>
            )}
          </>
        }
      >
        <NoticeText>{t('chat.spend.paused', { spent })}</NoticeText>
      </NoticeCard>
    )
  }
  return (
    <NoticeCard
      tone="warning"
      icon={<Gauge size={14} className="shrink-0 text-warning" />}
      actions={
        onAdjust && (
          <button
            type="button"
            onClick={onAdjust}
            className="focus-ring shrink-0 rounded text-sm font-semibold text-warning hover:underline"
          >
            {t('chat.spend.adjust')}
          </button>
        )
      }
    >
      <NoticeText>
        {payload.limitUsd !== null
          ? t('chat.spend.warningWithLimit', { spent, limit: formatUsd(payload.limitUsd, i18n.language) })
          : t('chat.spend.warning', { spent })}
      </NoticeText>
    </NoticeCard>
  )
}
