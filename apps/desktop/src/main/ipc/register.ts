import type { AppSettingsWatcher } from '../app/settings'
import type { DaemonManager } from '../daemon/manager'
import type { VncBridge } from '../services/vnc-bridge'
import { designInvokes } from './design'
import { fileInvokes } from './files'
import { type InvokeHandlers, registerHandlers } from './handle'
import { systemInvokes } from './system'
import { windowInvokes, windowSends } from './windows'

export interface IpcDeps {
  daemon: DaemonManager
  vncBridge: VncBridge
  settings: AppSettingsWatcher
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
