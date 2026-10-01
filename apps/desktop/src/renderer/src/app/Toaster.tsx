import { useTranslation } from 'react-i18next'

import { useAppStore } from '@/features/workspace/store'

export function Toaster() {
  const { t } = useTranslation()
  const toast = useAppStore((s) => s.toast)
  return (
    <div
      aria-live="polite"
      className="pointer-events-none absolute bottom-6 left-1/2 z-toast -translate-x-1/2"
    >
      {toast && (
        <div className="rounded-lg bg-fg px-3 py-1.5 text-sm font-medium text-bg shadow-lg">
          {t(`toast.${toast}`)}
        </div>
      )}
    </div>
  )
}
