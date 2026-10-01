import type { OfficeStatus } from '@milibot/shared'
import type { TFunction } from 'i18next'

export interface OfficeStatusView {
  tone: 'success' | 'progress' | 'warning' | 'danger'
  text: string
  /** 0..1 for the bar; null = no bar (or an indeterminate spinner). */
  progress: number | null
  retry: boolean
}

/** Status line under the "Old Office files" switch; null when there is nothing to say (off). */
export function officeStatusView(status: OfficeStatus, t: TFunction): OfficeStatusView | null {
  const percent = status.progress === null ? null : Math.round(status.progress * 100)
  switch (status.state) {
    case 'off':
      return null
    case 'waiting_vm':
      return {
        tone: 'warning',
        text: t('knowledge.legacyOffice.status.waitingVm'),
        progress: null,
        retry: false,
      }
    case 'installing':
      return {
        tone: 'progress',
        text:
          percent === null
            ? t('knowledge.legacyOffice.status.starting')
            : t(
                status.phase === 'preparing'
                  ? 'knowledge.legacyOffice.status.preparing'
                  : 'knowledge.legacyOffice.status.installing',
                { percent },
              ),
        progress: status.progress,
        retry: false,
      }
    case 'removing':
      return {
        tone: 'progress',
        text: t('knowledge.legacyOffice.status.removing', { percent: percent ?? 0 }),
        progress: status.progress,
        retry: false,
      }
    case 'installed':
      return {
        tone: 'success',
        text: t('knowledge.legacyOffice.status.installed'),
        progress: null,
        retry: false,
      }
    case 'error':
      return {
        tone: 'danger',
        text: t(
          status.enabled
            ? 'knowledge.legacyOffice.status.installFailed'
            : 'knowledge.legacyOffice.status.removeFailed',
        ),
        progress: null,
        retry: true,
      }
  }
}
