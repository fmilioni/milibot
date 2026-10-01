import { LEGACY_OFFICE_INSTALL_MB } from '@milibot/shared'
import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'

import { officeStatusView } from '@/features/knowledge/lib/legacy-office'
import { SettingsCard, SettingsRow } from '@/features/settings/SettingsLayout'
import { useWorkspacePreferences } from '@/features/settings/store'
import { toastOnError } from '@/features/workspace/store'
import { Switch } from '@/ui/Switch'

import { useOfficeStore } from './office-store'
import { StatusStrip } from './StatusStrip'

/** Turns "Old Office files" on or off; loads the preference and the install status. */
function useLegacyOffice(workspaceId: string) {
  const { prefs, loaded, set } = useWorkspacePreferences(workspaceId)
  const status = useOfficeStore((s) => (s.workspaceId === workspaceId ? s.status : null))
  const loadStatus = useOfficeStore((s) => s.load)

  useEffect(() => {
    void loadStatus(workspaceId).catch(() => undefined)
  }, [workspaceId, loadStatus])

  return {
    enabled: loaded ? prefs.legacyOffice : (status?.enabled ?? false),
    loaded,
    status,
    setEnabled: (legacyOffice: boolean) => set({ legacyOffice }),
  }
}

/** Settings › Knowledge: the switch, with the install progress in the VM under it. */
export function LegacyOfficeCard({ workspaceId }: { workspaceId: string }) {
  const { t } = useTranslation()
  const retry = useOfficeStore((s) => s.retry)
  const { enabled, loaded, status, setEnabled } = useLegacyOffice(workspaceId)
  const view = status ? officeStatusView(status, t) : null

  return (
    <SettingsCard>
      <SettingsRow
        label={t('knowledge.legacyOffice.label')}
        hint={t('knowledge.legacyOffice.hint', { size: status?.installMb ?? LEGACY_OFFICE_INSTALL_MB })}
      >
        <Switch
          checked={enabled}
          disabled={!loaded}
          label={t('knowledge.legacyOffice.label')}
          onChange={(value) => void setEnabled(value)}
        />
      </SettingsRow>
      {view && (
        <StatusStrip
          tone={view.tone}
          text={view.text}
          progress={view.progress}
          error={view.tone === 'danger' ? status?.error : null}
          {...(view.retry ? { onRetry: () => void toastOnError(retry(workspaceId)) } : {})}
        />
      )}
    </SettingsCard>
  )
}
