import type { LogFn, vmEndpoints } from '@milibot/shared'

import { errorMessage } from '../../errors'
import type { EndpointHandlers } from '../../handlers'
import { SETUP_VM_WAIT_GOLDEN_KEY } from '../../workspace-db/setup-keys'
import type { SettingsStore } from '../settings'
import { snapshotName, type VmAdmin } from './admin'
import type { VmController } from './controller'
import type { VmStatsSampler } from './stats'

/** The workspace VM from the app: start/stop and the settings screen's operations (`VmAdmin`). */
export class VmRoutes {
  constructor(
    private readonly deps: {
      vm: VmController
      settings: Pick<SettingsStore, 'get' | 'set'>
      admin: VmAdmin
      stats: Pick<VmStatsSampler, 'current'>
      now: () => number
      log: LogFn
    },
  ) {}

  handlers(): EndpointHandlers<Exclude<keyof typeof vmEndpoints, 'getHostInfo'>> {
    const { vm, settings, admin, stats, now, log } = this.deps
    const background = (what: string, promise: Promise<unknown>) =>
      void promise.catch((err: unknown) => log('warn', `${what} failed`, { err: errorMessage(err) }))
    return {
      getVm: () => vm.info(),
      startVm: () => {
        if (settings.get(SETUP_VM_WAIT_GOLDEN_KEY, false)) settings.set(SETUP_VM_WAIT_GOLDEN_KEY, false)
        background('vm start', vm.start())
        return vm.info()
      },
      stopVm: () => {
        background('vm stop', vm.stop())
        return vm.info()
      },
      resetVm: async () => {
        await admin.reset()
        return vm.info()
      },
      getVmDetails: () => admin.details(),
      getVmStats: () => ({ stats: stats.current() }),
      updateVmResources: ({ body }) => admin.updateResources(body),
      restartVm: ({ body }) => admin.restart(body.whenIdle),
      updateVmSystem: ({ body }) => admin.updateSystem(body.whenIdle),
      cancelVmSystemUpdate: () => admin.cancelSystemUpdate(),
      growVmDisk: ({ body }) => admin.growDisk(body.disk, body.sizeGb),
      createVmSnapshot: ({ body }) => admin.createSnapshot(body.name ?? snapshotName(now())),
      restoreVmSnapshot: ({ params }) => admin.restoreSnapshot(params.name),
      deleteVmSnapshot: ({ params }) => admin.deleteSnapshot(params.name),
    }
  }
}
