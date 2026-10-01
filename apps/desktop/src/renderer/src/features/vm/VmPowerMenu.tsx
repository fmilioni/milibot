import { Ellipsis, Power, RotateCcw } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { useAppStore } from '@/features/workspace/store'
import { useApiMutation } from '@/features/workspace/use-api-mutation'
import { Button } from '@/ui/Button'
import { Menu } from '@/ui/Menu'
import { Modal } from '@/ui/Modal'
import { Tooltip } from '@/ui/Tooltip'

import { stopVm } from './api'

/** "⋯" of the VM panel header: the VM's power (all bots), apart from the bot controls below the screen. */
export function VmPowerMenu() {
  const { t } = useTranslation()
  const vm = useAppStore((s) => s.vm)
  const startVm = useAppStore((s) => s.startVm)
  const workspaceId = useAppStore((s) => s.workspaceId)
  const showToast = useAppStore((s) => s.showToast)
  const stopMutation = useApiMutation((restart: boolean) => stopVm(workspaceId ?? '').then(() => restart), {
    onSuccess: (restart) => setRestarting(restart),
  })
  const button = useRef<HTMLButtonElement>(null)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const [confirm, setConfirm] = useState<'stop' | 'restart' | null>(null)
  const [restarting, setRestarting] = useState(false)

  useEffect(() => {
    if (!restarting || vm?.state !== 'stopped') return
    setRestarting(false)
    void startVm().catch(() => showToast('error'))
  }, [restarting, vm?.state, startVm, showToast])

  if (!vm || !workspaceId) return null
  const running = vm.state === 'running' || vm.state === 'starting'
  const stop = async (restart: boolean) => {
    setConfirm(null)
    await stopMutation.run(restart)
  }
  return (
    <>
      <Tooltip content={t('panels.vm.menu.label')}>
        <button
          ref={button}
          type="button"
          aria-label={t('panels.vm.menu.label')}
          aria-haspopup="menu"
          onClick={() => {
            const rect = button.current?.getBoundingClientRect()
            if (rect) setMenu({ x: rect.right - 200, y: rect.bottom + 6 })
          }}
          className="focus-ring rounded text-fg-secondary hover:text-fg"
        >
          <Ellipsis size={15} />
        </button>
      </Tooltip>
      {menu && (
        <Menu
          x={menu.x}
          y={menu.y}
          width={200}
          label={t('panels.vm.menu.label')}
          onClose={() => setMenu(null)}
          entries={
            running
              ? [
                  {
                    key: 'restart',
                    label: t('panels.vm.menu.restart'),
                    icon: <RotateCcw size={14} />,
                    onSelect: () => setConfirm('restart'),
                  },
                  {
                    key: 'stop',
                    label: t('panels.vm.menu.stop'),
                    icon: <Power size={14} />,
                    danger: true,
                    onSelect: () => setConfirm('stop'),
                  },
                ]
              : [
                  {
                    key: 'start',
                    label: t('panels.vm.menu.start'),
                    icon: <Power size={14} />,
                    disabled: vm.state === 'stopping',
                    onSelect: () => void startVm().catch(() => showToast('error')),
                  },
                ]
          }
        />
      )}
      {confirm && (
        <Modal
          title={t(confirm === 'stop' ? 'panels.vm.menu.stopTitle' : 'panels.vm.menu.restartTitle')}
          description={t(confirm === 'stop' ? 'panels.vm.menu.stopBody' : 'panels.vm.menu.restartBody')}
          width={400}
          onClose={() => setConfirm(null)}
        >
          <div className="flex justify-end gap-2 pt-2">
            <Button onClick={() => setConfirm(null)}>{t('common.cancel')}</Button>
            <Button variant="danger" onClick={() => void stop(confirm === 'restart')}>
              {t(confirm === 'stop' ? 'panels.vm.menu.confirmStop' : 'panels.vm.menu.confirmRestart')}
            </Button>
          </div>
        </Modal>
      )}
    </>
  )
}
