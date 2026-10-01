import { useTranslation } from 'react-i18next'

import { useAppStore } from '@/features/workspace/store'

export function ReconnectingBanner() {
  const { t } = useTranslation()
  const offline = useAppStore((s) => s.connectionState === 'offline')
  if (!offline) return null
  return (
    <div className="absolute top-3 left-1/2 z-overlay -translate-x-1/2 rounded-full bg-warning px-3 py-1 text-sm leading-4 font-semibold text-black/80">
      {t('app.reconnecting')}
    </div>
  )
}
