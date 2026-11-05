import { type ComputerKind, type HostInfo, VM_PRESETS, type VmSize } from '@milibot/shared'
import { Cpu } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { Notice } from '@/features/settings/SettingsLayout'
import type { ComputerSuggestion } from '@/features/setup/lib/setup-flow'

import { ComputerOption } from './ComputerOption'
import { LegacyOfficeOption, MachineSizePicker } from './MachineStep'
import { KvmNotice, QemuMissing, WhpxNotice } from './QemuStep'

const SMALLEST_VM_GB = Math.min(...VM_PRESETS.map((preset) => preset.memGb))

/** Step 1: the bots' computer, a VM with its size or none (preselected when this host can't run a VM well). */
export function ComputerStep({
  computer,
  suggestion,
  host,
  size,
  legacyOffice,
  onComputer,
  onSize,
  onLegacyOffice,
  onCheckQemu,
  onRecheckHost,
}: {
  computer: ComputerKind
  suggestion: ComputerSuggestion | null
  host: HostInfo | null
  size: VmSize | null
  legacyOffice: boolean
  onComputer: (computer: ComputerKind) => void
  onSize: (size: VmSize) => void
  onLegacyOffice: (checked: boolean) => void
  onCheckQemu: () => Promise<boolean>
  onRecheckHost: () => Promise<unknown>
}) {
  const { t } = useTranslation()
  const reason = suggestion?.kind === 'none' ? suggestion.reason : null
  const qemuMissing = host !== null && !host.qemu.found

  return (
    <>
      <p className="text-sm text-fg-secondary">{t('setup.computer.subtitle')}</p>
      {reason && (
        <Notice tone="warning" icon={<Cpu size={14} className="text-warning-strong" />}>
          <span className="flex flex-col gap-0.5">
            <span className="text-sm font-semibold text-fg">{t('setup.computer.suggestion.title')}</span>
            <span className="text-sm leading-[1.45] text-fg-secondary">
              {t(`setup.computer.suggestion.${reason}`, { mem: SMALLEST_VM_GB })}
            </span>
          </span>
        </Notice>
      )}
      <div role="radiogroup" aria-label={t('setup.computer.title')} className="flex flex-col gap-2">
        <ComputerOption
          kind="vm"
          description={t('setup.computer.vm.description')}
          selected={computer === 'vm'}
          warning={reason ? t(`setup.computer.vm.limits.${reason}`) : null}
          onSelect={() => onComputer('vm')}
        >
          {size && <MachineSizePicker size={size} host={host} onChange={onSize} />}
          <LegacyOfficeOption checked={legacyOffice} onChange={onLegacyOffice} />
          {qemuMissing && <QemuMissing onCheck={onCheckQemu} />}
          <KvmNotice setup={host?.setup ?? null} onCheck={onRecheckHost} />
          <WhpxNotice host={host} onCheck={onRecheckHost} />
        </ComputerOption>
        <ComputerOption
          kind="none"
          description={t('setup.computer.none.description')}
          selected={computer === 'none'}
          onSelect={() => onComputer('none')}
        />
      </div>
    </>
  )
}
