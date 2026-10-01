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

function readVmConfigFile(file: string): Partial<VmConfigFile> | null {
  try {
    const parsed = VmConfigFile.partial().safeParse(JSON.parse(readFileSync(file, 'utf8')))
    return parsed.success ? parsed.data : {}
  } catch {
    return null
  }
}

function vmStateOf(config: Partial<VmConfigFile> | null, qemuPid: string): WorkspaceOverview['vmState'] {
  if (config === null) return 'not_created'
  return qemuPidFileAlive(qemuPid) ? 'running' : 'stopped'
}

/** The VM state of a workspace without a runtime to ask, from its files. */
export function probeVmState(workspace: Workspace): WorkspaceOverview['vmState'] {
  const paths = workspacePaths(workspace.dir)
  return vmStateOf(readVmConfigFile(paths.vmConfig), paths.qemuPid)
}

/**
 * Reads what the settings screen lists for a workspace straight from its files: the VM config and
 * disks, and bot/group counts from `workspace.db` (read-only; the runtime may hold it open in WAL).
 */
export function workspaceOverview(workspace: Workspace): WorkspaceOverview {
  const paths = workspacePaths(workspace.dir)
  const config = readVmConfigFile(paths.vmConfig)
  const disks = [paths.systemDisk, paths.dataDisk].map(diskBytes)
  const counts = workspaceCounts(paths.db)
  const vmState = vmStateOf(config, paths.qemuPid)
  return {
    id: workspace.id,
    vmState,
    cpus: config?.cpus ?? null,
    memGb: config?.memGb ?? null,
    dataGb: config?.dataGb ?? null,
    diskUsedBytes: disks.some((d) => d !== null) ? disks.reduce<number>((sum, d) => sum + (d ?? 0), 0) : null,
    ...counts,
    workingBots: vmState === 'running' ? counts.workingBots : 0,
  }
}
