import { Cloud } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { useAppStore } from '@/features/workspace/store'
import { Tooltip } from '@/ui/Tooltip'

/** The footer's computer line for a workspace without one: it leads to where the computer is chosen. */
export function NoComputerLine() {
  const { t } = useTranslation()
  const openSettings = useAppStore((s) => s.openSettings)

  return (
    <Tooltip content={t('footer.noComputer.hint')}>
      <button
        type="button"
        onClick={() => openSettings('computer')}
        className="focus-ring -my-1 flex w-fit items-center gap-2 rounded-md px-1 py-1 text-sm leading-4 text-fg-secondary hover:bg-surface-3"
      >
        <Cloud size={13} className="shrink-0 text-fg-muted" aria-hidden />
        {t('footer.noComputer.label')}
      </button>
    </Tooltip>
  )
}
