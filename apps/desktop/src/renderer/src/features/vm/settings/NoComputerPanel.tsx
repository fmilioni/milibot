import { Check, HardDrive, Minus, Trash2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { SettingsCard } from '@/features/settings/SettingsLayout'
import { cliEngineNames } from '@/lib/cli-engines'
import { formatBytes } from '@/lib/format'
import { Button } from '@/ui/Button'

const CAN = ['chat', 'web', 'boards', 'attachments'] as const
const NEEDS_VM = ['shell', 'desktop', 'documents', 'cli'] as const

/**
 * The Computer page of a workspace without one: what the bots do and don't, and the disk a previous VM left
 * (`keptDiskBytes`, null when there is none).
 */
export function NoComputerPanel({
  keptDiskBytes,
  onDeleteDisk,
}: {
  keptDiskBytes: number | null
  onDeleteDisk: () => void
}) {
  const { t, i18n } = useTranslation()
  const engines = cliEngineNames(i18n.language)

  return (
    <>
      <SettingsCard>
        <div className="grid grid-cols-2 gap-6 px-4.5 py-4">
          <section className="flex flex-col gap-2">
            <h3 className="text-sm font-semibold text-fg">{t('settings.computer.can.title')}</h3>
            <ul className="flex flex-col gap-2">
              {CAN.map((item) => (
                <li key={item} className="flex items-center gap-2 text-sm text-fg-secondary">
                  <Check size={13} className="shrink-0 text-success" aria-hidden />
                  {t(`settings.computer.can.${item}`)}
                </li>
              ))}
            </ul>
          </section>
          <section className="flex flex-col gap-2">
            <h3 className="text-sm font-semibold text-fg">{t('settings.computer.needsVm.title')}</h3>
            <ul className="flex flex-col gap-2">
              {NEEDS_VM.map((item) => (
                <li key={item} className="flex items-center gap-2 text-sm text-fg-secondary">
                  <Minus size={13} className="shrink-0 text-fg-muted" aria-hidden />
                  {t(`settings.computer.needsVm.${item}`, { engines })}
                </li>
              ))}
            </ul>
          </section>
        </div>
      </SettingsCard>
      {keptDiskBytes !== null && (
        <SettingsCard>
          <div className="flex items-center gap-3.5 px-4 py-3.5">
            <HardDrive size={18} className="shrink-0 text-fg-secondary" aria-hidden />
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="text-base font-semibold text-fg">
                {t('settings.computer.keptDisk.title', { size: formatBytes(keptDiskBytes, i18n.language) })}
              </span>
              <span className="text-sm leading-[1.45] text-fg-secondary">
                {t('settings.computer.keptDisk.body')}
              </span>
            </div>
            <Button variant="danger-outline" size="sm" onClick={onDeleteDisk}>
              <Trash2 size={12} />
              {t('settings.computer.keptDisk.delete')}
            </Button>
          </div>
        </SettingsCard>
      )}
    </>
  )
}
