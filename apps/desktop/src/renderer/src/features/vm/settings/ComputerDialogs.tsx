import type { ComputerChoice, VmSize } from '@milibot/shared'
import { Play, Power, Trash2 } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { useSettingsStore } from '@/features/settings/store'
import { createMachineMinutes } from '@/features/setup/lib/setup'
import { initialVmSize } from '@/features/setup/lib/setup-flow'
import { MachineSizePicker } from '@/features/setup/MachineStep'
import { useSetupStore } from '@/features/setup/store'
import { errorMessage } from '@/lib/errors'
import { formatBytes } from '@/lib/format'
import { Button } from '@/ui/Button'
import { ConfirmDialog } from '@/ui/Confirm'
import { Modal } from '@/ui/Modal'
import { Spinner } from '@/ui/Spinner'

/** Runs a dialog's action, keeping it open with the error when it fails. */
function useDialogAction(action: () => Promise<unknown>) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const run = async () => {
    setBusy(true)
    setError(null)
    try {
      await action()
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return { busy, error, run }
}

function DialogFooter({
  busy,
  error,
  icon,
  label,
  disabled = false,
  onConfirm,
  onClose,
}: {
  busy: boolean
  disabled?: boolean
  error: string | null
  icon: ReactNode
  label: string
  onConfirm: () => void
  onClose: () => void
}) {
  const { t } = useTranslation()

  return (
    <>
      {error && <p className="selectable text-sm text-danger">{error}</p>}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>
          {t('common.cancel')}
        </Button>
        <Button variant="primary" disabled={busy || disabled} onClick={onConfirm}>
          {busy ? <Spinner size={13} /> : icon}
          {label}
        </Button>
      </div>
    </>
  )
}

/** Leaving the VM: it is shut down (running work stops) and its disk is kept. */
export function LeaveVmDialog({ onSwitch, onClose }: { onSwitch: () => Promise<void>; onClose: () => void }) {
  const { t } = useTranslation()
  const action = useDialogAction(onSwitch)

  return (
    <Modal title={t('settings.computer.leave.title')} width={440} onClose={onClose}>
      <div className="flex flex-col gap-4">
        <p className="text-base leading-[1.5] text-fg-secondary">{t('settings.computer.leave.body')}</p>
        <DialogFooter
          {...action}
          icon={<Power size={13} />}
          label={action.busy ? t('settings.computer.leave.busy') : t('settings.computer.leave.confirm')}
          onConfirm={() => void action.run()}
          onClose={onClose}
        />
      </div>
    </Modal>
  )
}

/**
 * Moving to a VM: a new one is sized here; a workspace that kept its previous disk (`keptDisk`) gets that VM
 * back at its stored size.
 */
export function UseVmDialog({
  keptDisk,
  onSwitch,
  onClose,
}: {
  keptDisk: boolean
  onSwitch: (choice: ComputerChoice) => Promise<void>
  onClose: () => void
}) {
  const { t } = useTranslation()
  const host = useSettingsStore((s) => s.host)
  const golden = useSetupStore((s) => s.golden)
  const [chosenSize, setSize] = useState<VmSize | null>(null)
  const size = chosenSize ?? initialVmSize(host, null, true)
  const choice: ComputerChoice | null = keptDisk ? { kind: 'vm' } : size && { kind: 'vm', size }
  const action = useDialogAction(async () => {
    if (choice) {
      await onSwitch(choice)
    }
  })

  const label = keptDisk
    ? t('settings.computer.use.resume')
    : t('setup.machine.create', { minutes: createMachineMinutes(golden) })

  return (
    <Modal title={t('settings.computer.use.title')} width={keptDisk ? 440 : 580} onClose={onClose}>
      <div className="flex flex-col gap-4">
        <p className="text-base leading-[1.5] text-fg-secondary">
          {keptDisk ? t('settings.computer.use.bodyResume') : t('settings.computer.use.body')}
        </p>
        {!keptDisk && size && <MachineSizePicker size={size} host={host} onChange={setSize} />}
        <DialogFooter
          {...action}
          disabled={!choice}
          icon={<Play size={12} />}
          label={label}
          onConfirm={() => void action.run()}
          onClose={onClose}
        />
      </div>
    </Modal>
  )
}

/** Deleting the disk a workspace kept from its VM: the bots' /workspace files go with it. */
export function DeleteVmDiskDialog({
  bytes,
  onDelete,
  onClose,
}: {
  bytes: number
  onDelete: () => Promise<void>
  onClose: () => void
}) {
  const { t, i18n } = useTranslation()

  return (
    <ConfirmDialog
      title={t('settings.computer.deleteDisk.title')}
      body={t('settings.computer.deleteDisk.body', { size: formatBytes(bytes, i18n.language) })}
      confirmLabel={t('settings.computer.deleteDisk.confirm')}
      busyLabel={t('settings.computer.deleteDisk.busy')}
      confirmIcon={<Trash2 size={13} />}
      onConfirm={onDelete}
      onClose={onClose}
    />
  )
}
