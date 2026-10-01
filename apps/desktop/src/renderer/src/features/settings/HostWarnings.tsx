import { KeyRound, Turtle } from 'lucide-react'
import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'

import { Notice } from './SettingsLayout'
import { useSettingsStore } from './store'

function useHost() {
  const host = useSettingsStore((s) => s.host)
  const loadHost = useSettingsStore((s) => s.loadHost)
  useEffect(() => {
    void loadHost().catch(() => undefined)
  }, [loadHost])
  return host
}

/** The VM runs emulated (no HVF/KVM/WHPX): everything works, only much slower. */
export function TcgNotice() {
  const { t } = useTranslation()
  const host = useHost()
  const accel = host?.vmAccel
  if (!accel?.slow) return null
  return (
    <Notice icon={<Turtle size={14} className="text-warning" />} tone="warning">
      {t('settings.hostWarnings.tcg')}
      {accel.reason && (
        <span className="mt-1 block">
          {t(`settings.hostWarnings.reasons.${accel.reason}`, { defaultValue: accel.reason })}
        </span>
      )}
    </Notice>
  )
}

/**
 * Secrets are not in the system keyring as usual: no keyring at all (Linux without a GNOME/KDE session, so
 * an encrypted file holds them), or the keyring that holds them did not answer (locked, not started yet).
 */
export function KeyringNotice() {
  const { t } = useTranslation()
  const host = useHost()
  const text =
    host?.secretStoreWarning === 'keyring_unreachable'
      ? t('settings.hostWarnings.keyringUnreachable')
      : host?.secretStore === 'encrypted_file'
        ? t('settings.hostWarnings.keyring')
        : null
  if (!text) return null
  return (
    <Notice icon={<KeyRound size={14} className="text-warning" />} tone="warning">
      {text}
    </Notice>
  )
}
