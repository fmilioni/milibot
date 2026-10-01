import { join } from 'node:path'

import {
  dataLayout,
  defaultDataRoot,
  type Host,
  resolveDataRoot as resolveHostDataRoot,
} from '@milibot/shared'

declare const __MILIBOT_VERSION__: string | undefined

/** The root package.json version, injected by the bundle build; sources report `dev`. */
export const DAEMON_VERSION = typeof __MILIBOT_VERSION__ === 'string' ? __MILIBOT_VERSION__ : 'dev'

/** `MILIBOT_DATA_DIR`, else the platform's data folder (see `defaultDataRoot` in shared/platform.ts). */
export function resolveDataRoot(host: Host): string {
  return resolveHostDataRoot(host)
}

/** The platform's data folder (`LOCALAPPDATA`, `XDG_DATA_HOME` respected), ignoring `MILIBOT_DATA_DIR`. */
export function platformDataRoot(host: Host): string {
  return defaultDataRoot(host)
}

export function dataPaths(dataRoot: string) {
  const { daemonInfo, logsDir } = dataLayout(dataRoot, process.platform)
  return {
    root: dataRoot,
    appDb: join(dataRoot, 'app.db'),
    daemonInfo,
    workspacesDir: join(dataRoot, 'workspaces'),
    imagesDir: join(dataRoot, 'images'),
    logsDir,
  }
}

/** Files of a workspace; the VM ones are written by the workspace VM CLI (`vm/host`). */
export function workspacePaths(workspaceDir: string) {
  const vmDir = join(workspaceDir, 'vm')
  return {
    dir: workspaceDir,
    db: join(workspaceDir, 'workspace.db'),
    vmDir,
    vmConfig: join(vmDir, 'config.json'),
    qemuPid: join(vmDir, 'qemu.pid'),
    qemuLog: join(vmDir, 'qemu.log'),
    agentToken: join(vmDir, 'agent.token'),
    systemDisk: join(vmDir, 'system.qcow2'),
    dataDisk: join(vmDir, 'data.qcow2'),
  }
}
