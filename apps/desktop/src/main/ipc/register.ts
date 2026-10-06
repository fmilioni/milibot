import type { AppSettingsWatcher } from '../app/settings'
import type { DaemonManager } from '../daemon/manager'
import type { KeepAwakeGuard } from '../services/keep-awake/guard'
import type { VncBridge } from '../services/vnc-bridge'
import type { AppUpdateService } from '../update/app-updater'
import { designInvokes } from './design'
import { fileInvokes } from './files'
import { type InvokeHandlers, registerHandlers } from './handle'
import { systemInvokes } from './system'
import { windowInvokes, windowSends } from './windows'

export interface IpcDeps {
  daemon: DaemonManager
  vncBridge: VncBridge
  settings: AppSettingsWatcher
  keepAwake: KeepAwakeGuard
  appUpdate: AppUpdateService
}

function ipcHandlers(deps: IpcDeps) {
  const invokes = {
    ...windowInvokes(deps),
    ...fileInvokes(deps),
    ...systemInvokes(deps),
    ...designInvokes(),
  } satisfies InvokeHandlers
  return { invokes, sends: windowSends }
}

export function registerIpc(deps: IpcDeps): void {
  const { invokes, sends } = ipcHandlers(deps)
  registerHandlers(invokes, sends)
}
