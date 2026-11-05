import type { ComputerChoice, ComputerKind } from '@milibot/shared'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { queryKeys } from '@/api/queries'
import { useApiQuery } from '@/api/use-api-query'
import { listWorkspaceOverviews } from '@/features/settings/api'
import { SettingsPage } from '@/features/settings/SettingsLayout'
import { useSettingsStore } from '@/features/settings/store'
import { ComputerOption } from '@/features/setup/ComputerOption'
import { vmBeingCreated } from '@/features/setup/lib/setup'
import { MachineProgress } from '@/features/setup/MachineStep'
import { useSetupStore } from '@/features/setup/store'
import { useVmProgress } from '@/features/setup/use-vm-progress'
import { useAppStore, useCurrentWorkspace } from '@/features/workspace/store'

import { DeleteVmDiskDialog, LeaveVmDialog, UseVmDialog } from './ComputerDialogs'
import { NoComputerPanel } from './NoComputerPanel'
import { VmSettings } from './VmSettings'

type Dialog = 'leaveVm' | 'useVm' | 'deleteDisk'

/** Settings › Computer: where the bots of this workspace work, and that computer's settings. */
export function ComputerSettings() {
  const { t } = useTranslation()
  const workspace = useCurrentWorkspace()
  const setComputer = useAppStore((s) => s.setComputer)
  const deleteVmDisk = useAppStore((s) => s.deleteVmDisk)
  const showToast = useAppStore((s) => s.showToast)
  const loadHost = useSettingsStore((s) => s.loadHost)
  const loadGolden = useSetupStore((s) => s.loadGolden)
  const overviews = useApiQuery(queryKeys.workspaceOverviews(), listWorkspaceOverviews)
  const [dialog, setDialog] = useState<Dialog | null>(null)

  useEffect(() => {
    void loadHost().catch(() => undefined)
    void loadGolden().catch(() => undefined)
  }, [loadHost, loadGolden])

  if (!workspace) {
    return null
  }

  const kind = workspace.computer
  const keptDiskBytes = overviews.data?.find((o) => o.id === workspace.id)?.diskUsedBytes ?? null

  const choose = (next: ComputerKind) => {
    if (next === kind) {
      return
    }

    setDialog(next === 'vm' ? 'useVm' : 'leaveVm')
  }

  const switchTo = async (choice: ComputerChoice) => {
    await setComputer(choice)
    setDialog(null)
    overviews.reload()
  }

  const deleteDisk = async () => {
    await deleteVmDisk()
    setDialog(null)
    overviews.reload()
    showToast('vmDiskDeleted')
  }

  const chooser = (
    <div role="radiogroup" aria-label={t('settings.computer.subtitle')} className="flex gap-2.5">
      <ComputerOption
        kind="vm"
        description={t('settings.computer.options.vm')}
        selected={kind === 'vm'}
        onSelect={() => choose('vm')}
      />
      <ComputerOption
        kind="none"
        description={t('settings.computer.options.none')}
        selected={kind === 'none'}
        onSelect={() => choose('none')}
      />
    </div>
  )

  return (
    <>
      {kind === 'vm' ? (
        <VmSettings
          lead={
            <>
              {chooser}
              <VmCreation />
            </>
          }
        />
      ) : (
        <SettingsPage title={t('settings.sections.computer')} subtitle={t('settings.computer.subtitle')}>
          {chooser}
          <NoComputerPanel keptDiskBytes={keptDiskBytes} onDeleteDisk={() => setDialog('deleteDisk')} />
        </SettingsPage>
      )}
      {dialog === 'leaveVm' && (
        <LeaveVmDialog onSwitch={() => switchTo({ kind: 'none' })} onClose={() => setDialog(null)} />
      )}
      {dialog === 'useVm' && (
        <UseVmDialog keptDisk={keptDiskBytes !== null} onSwitch={switchTo} onClose={() => setDialog(null)} />
      )}
      {dialog === 'deleteDisk' && keptDiskBytes !== null && (
        <DeleteVmDiskDialog bytes={keptDiskBytes} onDelete={deleteDisk} onClose={() => setDialog(null)} />
      )}
    </>
  )
}

/** The image build and first boot of a VM the workspace just switched to, as the setup shows them. */
function VmCreation() {
  const vm = useAppStore((s) => s.vm)
  const startVm = useAppStore((s) => s.startVm)
  const golden = useSetupStore((s) => s.golden)
  const buildGolden = useSetupStore((s) => s.buildGolden)
  const creating = vmBeingCreated(golden, vm)
  const progress = useVmProgress(golden, vm, creating)
  const [retrying, setRetrying] = useState(false)

  if (!creating) {
    return null
  }

  const whileRetrying = async (action: () => Promise<unknown>) => {
    setRetrying(true)
    try {
      await action()
    } catch {
      // The progress keeps showing the failure.
    } finally {
      setRetrying(false)
    }
  }

  return (
    <MachineProgress
      progress={progress}
      golden={golden}
      vmError={vm?.error ?? null}
      onRetry={() => void whileRetrying(progress.failed === 'golden' ? buildGolden : startVm)}
      onUseCurrent={() => void whileRetrying(startVm)}
      retrying={retrying}
    />
  )
}
