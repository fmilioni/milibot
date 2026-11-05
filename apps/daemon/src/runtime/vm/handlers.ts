import type { ComputerKind, LogFn, vmEndpoints } from '@milibot/shared'

import { errorMessage } from '../../errors'
import type { EndpointHandlers } from '../../handlers'
import { SETUP_VM_WAIT_GOLDEN_KEY } from '../../workspace-db/setup-keys'
import type { SettingsStore } from '../settings'
import { snapshotName, type VmAdmin } from './admin'
import { noComputerError, type VmController } from './controller'
import type { VmStatsSampler } from './stats'

/** The workspace VM from the app: start/stop and the settings screen's operations (`VmAdmin`). */
export class VmRoutes {
  constructor(
    private readonly deps: {
      vm: VmController
      computer: ComputerKind
      settings: Pick<SettingsStore, 'get' | 'set'>
      admin: VmAdmin
      stats: Pick<VmStatsSampler, 'current'>
      now: () => number
      log: LogFn
    },
  ) {}

  handlers(): EndpointHandlers<Exclude<keyof typeof vmEndpoints, 'getHostInfo'>> {
    const { vm, computer, settings, admin, stats, now, log } = this.deps
    const background = (what: string, promise: Promise<unknown>) =>
      void promise.catch((err: unknown) => log('warn', `${what} failed`, { err: errorMessage(err) }))
    /** Operations on the VM itself; reads and stops stay open, since they need no VM to answer. */
    const needsComputer = () => {
      if (computer === 'none') {
        throw noComputerError()
      }
    }

    return {
      getVm: () => vm.info(),
      startVm: () => {
        needsComputer()
        if (settings.get(SETUP_VM_WAIT_GOLDEN_KEY, false)) {
          settings.set(SETUP_VM_WAIT_GOLDEN_KEY, false)
        }

        background('vm start', vm.start())
        return vm.info()
      },
      stopVm: () => {
        background('vm stop', vm.stop())
        return vm.info()
      },
      resetVm: async () => {
        needsComputer()
        await admin.reset()
        return vm.info()
      },
      getVmDetails: () => admin.details(),
      getVmStats: () => ({ stats: stats.current() }),
      updateVmResources: ({ body }) => {
        needsComputer()
        return admin.updateResources(body)
      },
      restartVm: ({ body }) => {
        needsComputer()
        return admin.restart(body.whenIdle)
      },
      updateVmSystem: ({ body }) => {
        needsComputer()
        return admin.updateSystem(body.whenIdle)
      },
      cancelVmSystemUpdate: () => admin.cancelSystemUpdate(),
      growVmDisk: ({ body }) => {
        needsComputer()
        return admin.growDisk(body.disk, body.sizeGb)
      },
      createVmSnapshot: ({ body }) => {
        needsComputer()
        return admin.createSnapshot(body.name ?? snapshotName(now()))
      },
      restoreVmSnapshot: ({ params }) => {
        needsComputer()
        return admin.restoreSnapshot(params.name)
      },
      deleteVmSnapshot: ({ params }) => {
        needsComputer()
        return admin.deleteSnapshot(params.name)
      },
    }
  }
}
