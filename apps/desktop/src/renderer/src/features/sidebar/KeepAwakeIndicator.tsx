import { Coffee } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { useAppStore } from '@/features/workspace/store'
import { Tooltip } from '@/ui/Tooltip'

import type { KeepAwakeState } from '../../../../bridge/contract'

/** The main process's lock, every workspace included; an event that beats the first answer wins. */
function useKeepAwake(): KeepAwakeState | null {
  const [state, setState] = useState<KeepAwakeState | null>(null)
  useEffect(() => {
    let live = true
    const off = window.milibot.onKeepAwakeChanged(setState)
    window.milibot
      .getKeepAwake()
      .then((first) => live && setState((current) => current ?? first))
      .catch(() => undefined)
    return () => {
      live = false
      off()
    }
  }, [])
  return state
}

/** Shown only while the app keeps the computer from sleeping; opens the settings where it is turned off. */
export function KeepAwakeIndicator() {
  const { t } = useTranslation()
  const openSettings = useAppStore((s) => s.openSettings)
  const state = useKeepAwake()
  if (!state?.active) return null
  const label = t('footer.keepAwake', { count: state.busyBots })
  return (
    <Tooltip content={label}>
      <button
        type="button"
        aria-label={label}
        onClick={() => openSettings('general')}
        className="focus-ring rounded hover:text-fg"
      >
        <Coffee size={15} />
      </button>
    </Tooltip>
  )
}
