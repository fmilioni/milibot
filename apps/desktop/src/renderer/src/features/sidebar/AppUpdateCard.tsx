import { CircleArrowUp, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { toastOnError, useAppStore } from '@/features/workspace/store'
import { ConfirmDialog } from '@/ui/Confirm'
import { Tooltip } from '@/ui/Tooltip'

import type { AppUpdateState } from '../../../../bridge/contract'

const DISMISSED_KEY = 'milibot.appUpdate.dismissed'

function dismissedVersion(): string | null {
  try {
    return localStorage.getItem(DISMISSED_KEY)
  } catch {
    return null
  }
}

function dismissVersion(version: string): void {
  try {
    localStorage.setItem(DISMISSED_KEY, version)
  } catch {
    // Storage blocked: the card simply comes back next time.
  }
}

/** The main process's updater; an event that beats the first answer wins. */
function useAppUpdate(): AppUpdateState | null {
  const [state, setState] = useState<AppUpdateState | null>(null)
  useEffect(() => {
    let live = true
    const off = window.milibot.onAppUpdateChanged(setState)
    window.milibot
      .getAppUpdate()
      .then((first) => live && setState((current) => current ?? first))
      .catch(() => undefined)
    return () => {
      live = false
      off()
    }
  }, [])
  return state
}

/**
 * Shown once a new version of the app is downloaded: the click restarts into it (after a confirmation while
 * bots work, since the update replaces the service they run on). Dismissed, it stays hidden until the next
 * version.
 */
export function AppUpdateCard() {
  const { t } = useTranslation()
  const state = useAppUpdate()
  const [dismissed, setDismissed] = useState(dismissedVersion)
  const [busyBots, setBusyBots] = useState<number | null>(null)
  if (state?.status !== 'ready' && state?.status !== 'installing') return null
  const { version } = state
  const installing = state.status === 'installing'
  if (!installing && dismissed === version) return null

  const install = async () => {
    setBusyBots(null)
    const started = await toastOnError(window.milibot.installAppUpdate())
    if (started === false) useAppStore.getState().showToast('error')
  }
  const requestInstall = async () => {
    const working = (await window.milibot.getKeepAwake().catch(() => null))?.busyBots ?? 0
    if (working > 0) setBusyBots(working)
    else await install()
  }

  return (
    <div className="flex items-center gap-2.5 rounded-xl bg-accent-soft py-2.5 pr-2 pl-3">
      <CircleArrowUp size={16} className="shrink-0 text-accent" aria-hidden />
      <button
        type="button"
        disabled={installing}
        onClick={() => void requestInstall()}
        className="focus-ring flex min-w-0 flex-1 flex-col items-start rounded text-left disabled:cursor-default"
      >
        <span className="max-w-full truncate text-sm font-semibold text-fg">
          {t('footer.appUpdate.title')}
        </span>
        {/* Wraps instead of truncating: the version is the point of the line. */}
        <span className="max-w-full text-sm text-accent">
          {installing ? t('footer.appUpdate.installing') : t('footer.appUpdate.link', { version })}
        </span>
      </button>
      {!installing && (
        <Tooltip content={t('footer.appUpdate.dismiss')}>
          <button
            type="button"
            aria-label={t('footer.appUpdate.dismiss')}
            onClick={() => {
              dismissVersion(version)
              setDismissed(version)
            }}
            className="focus-ring flex size-6 shrink-0 items-center justify-center rounded-md text-fg-muted hover:bg-surface-3 hover:text-fg"
          >
            <X size={14} />
          </button>
        </Tooltip>
      )}
      {busyBots !== null && (
        <ConfirmDialog
          title={t('footer.appUpdate.confirmTitle', { version })}
          body={t('footer.appUpdate.confirmBody', { count: busyBots })}
          confirmLabel={t('footer.appUpdate.confirm')}
          onConfirm={install}
          onClose={() => setBusyBots(null)}
        />
      )}
    </div>
  )
}
