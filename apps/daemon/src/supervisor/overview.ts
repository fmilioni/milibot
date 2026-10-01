import { readFileSync } from 'node:fs'

import { VmConfigFile, type Workspace, type WorkspaceOverview } from '@milibot/shared'
import { qemuIdentity } from '@milibot/vm-host'

import { workspacePaths } from '../config/paths'
import { diskBytes } from '../host/info'
import { workspaceCounts } from '../workspace-db/readonly-queries'

/** A pid file whose process is a live QEMU (a stale file after a reboot can name an unrelated process). */
function qemuPidFileAlive(pidFile: string): boolean {
  try {
    const pid = Number(readFileSync(pidFile, 'utf8').trim())
    return Number.isInteger(pid) && pid > 0 && qemuIdentity(pid) !== 'no'
  } catch {
    return false
  }
}

/**
 * Reads what the settings screen lists for a workspace straight from its files: the VM config and
 * disks, and bot/group counts from `workspace.db` (read-only; the runtime may hold it open in WAL).
 */
export function workspaceOverview(workspace: Workspace): WorkspaceOverview {
  const paths = workspacePaths(workspace.dir)
  let config: Partial<VmConfigFile> | null
  try {
    const parsed = VmConfigFile.partial().safeParse(JSON.parse(readFileSync(paths.vmConfig, 'utf8')))
    config = parsed.success ? parsed.data : {}
  } catch {
    config = null
  }
  const disks = [paths.systemDisk, paths.dataDisk].map(diskBytes)
  const counts = workspaceCounts(paths.db)
  const running = config !== null && qemuPidFileAlive(paths.qemuPid)
  return {
    id: workspace.id,
    vmState: config === null ? 'not_created' : running ? 'running' : 'stopped',
    cpus: config?.cpus ?? null,
    memGb: config?.memGb ?? null,
    dataGb: config?.dataGb ?? null,
    diskUsedBytes: disks.some((d) => d !== null) ? disks.reduce<number>((sum, d) => sum + (d ?? 0), 0) : null,
    ...counts,
    workingBots: running ? counts.workingBots : 0,
  }
}
