import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { useAppStore } from '@/features/workspace/store'
import { platformKind } from '@/lib/platform'
import { Switch } from '@/ui/Switch'

import { SettingsCard, SettingsRow } from './SettingsLayout'

/**
 * App-wide (not per workspace): the daemon starts when the user logs in (hidden where the platform has no
 * login item, `getLoginItem` → null), and the computer stays awake while bots work.
 */
export function ComputerCard() {
  const { t } = useTranslation()
  const showToast = useAppStore((s) => s.showToast)
  const keepAwake = useAppStore((s) => s.appSettings.keepAwake)
  const updateAppSettings = useAppStore((s) => s.updateAppSettings)
  const [enabled, setEnabled] = useState<boolean | null | undefined>(undefined)
  useEffect(() => {
    let active = true
    window.milibot
      .getLoginItem()
      .then((value) => active && setEnabled(value))
      .catch(() => active && setEnabled(false))
    return () => {
      active = false
    }
  }, [])
  const change = (value: boolean) => {
    const previous = enabled
    setEnabled(value)
    window.milibot
      .setLoginItem(value)
      .then(setEnabled)
      .catch(() => {
        setEnabled(previous)
        showToast('error')
      })
  }
  return (
    <SettingsCard title={t('settings.general.thisComputer')}>
      {enabled !== null && (
        <SettingsRow
          label={t('settings.general.launchAtLogin')}
          hint={t('settings.general.launchAtLoginHint')}
        >
          <Switch
            checked={enabled ?? false}
            disabled={enabled === undefined}
            label={t('settings.general.launchAtLogin')}
            onChange={change}
          />
        </SettingsRow>
      )}
      <SettingsRow
        label={t('settings.general.keepAwake')}
        hint={t(`settings.general.keepAwakeHint.${platformKind()}`)}
      >
        <Switch
          checked={keepAwake}
          label={t('settings.general.keepAwake')}
          onChange={(value) => void updateAppSettings({ keepAwake: value }).catch(() => showToast('error'))}
        />
      </SettingsRow>
    </SettingsCard>
  )
}
