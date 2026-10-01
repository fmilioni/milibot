import { CircleArrowUp, X } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import {
  availableSystemRevision,
  dismissSystemUpdate,
  isSystemUpdateDismissed,
} from '@/features/vm/lib/system-update'
import { useAppStore } from '@/features/workspace/store'
import { Tooltip } from '@/ui/Tooltip'

/** Shown while the workspace VM runs an older system than this app version builds. */
export function SystemUpdateCard() {
  const { t } = useTranslation()
  const workspaceId = useAppStore((s) => s.workspaceId)
  const vm = useAppStore((s) => s.vm)
  const openSettings = useAppStore((s) => s.openSettings)
  const revision = availableSystemRevision(vm)
  const [dismissed, setDismissed] = useState<string | null>(null)
  if (!workspaceId || revision === null) return null
  const key = `${workspaceId}:${revision}`
  if (dismissed === key || isSystemUpdateDismissed(workspaceId, revision)) return null
  return (
    <div className="mx-3 mb-2.5 flex items-center gap-2.5 rounded-xl bg-accent-soft py-2.5 pr-2 pl-3">
      <CircleArrowUp size={16} className="shrink-0 text-accent" aria-hidden />
      <button
        type="button"
        onClick={() => openSettings('vm')}
        className="focus-ring flex min-w-0 flex-1 flex-col items-start rounded text-left"
      >
        <span className="truncate text-sm font-semibold text-fg">{t('footer.systemUpdate.title')}</span>
        <span className="truncate text-sm text-accent">{t('footer.systemUpdate.link')}</span>
      </button>
      <Tooltip content={t('footer.systemUpdate.dismiss')}>
        <button
          type="button"
          aria-label={t('footer.systemUpdate.dismiss')}
          onClick={() => {
            dismissSystemUpdate(workspaceId, revision)
            setDismissed(key)
          }}
          className="focus-ring flex size-6 shrink-0 items-center justify-center rounded-md text-fg-muted hover:bg-surface-3 hover:text-fg"
        >
          <X size={14} />
        </button>
      </Tooltip>
    </div>
  )
}
