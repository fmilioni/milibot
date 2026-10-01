import type { ErrorPayload } from '@milibot/shared'
import { CircleAlert } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/ui/Button'

import { errorTitle, loginEngineOf } from '../lib/error-text'
import { NoticeCard, NoticeLines } from './NoticeCard'

/** `onOpenScreen` powers the login CTA (the CLI engines' logins run in a VM terminal). */
export function ErrorCard({ payload, onOpenScreen }: { payload: ErrorPayload; onOpenScreen?: () => void }) {
  const { t } = useTranslation()
  return (
    <NoticeCard
      tone="danger"
      className="border border-danger-soft"
      icon={<CircleAlert size={14} className="shrink-0 text-danger" />}
      actions={
        loginEngineOf(payload) &&
        onOpenScreen && (
          <Button size="sm" variant="outline" onClick={onOpenScreen} className="px-2.5">
            {t('chat.error.openLoginTerminal')}
          </Button>
        )
      }
    >
      <NoticeLines>
        <span className="text-base font-semibold text-fg">{errorTitle(t, payload)}</span>
        <span className="text-sm leading-[15px] text-fg-secondary">{payload.detail}</span>
      </NoticeLines>
    </NoticeCard>
  )
}
