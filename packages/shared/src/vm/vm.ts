import { z } from 'zod'

import { endpoint } from '../http/endpoint'
import type { VmAccel } from '../portable/platform'

export const VmState = z.enum([
  'not_created',
  'stopped',
  'starting',
  'running',
  'stopping',
  'suspended',
  'error',
])
export type VmState = z.infer<typeof VmState>

export const VmConfig = z.object({
  cpus: z.number().int().positive(),
  memGb: z.number().int().positive(),
  dataGb: z.number().int().positive(),
  systemGb: z.number().int().positive(),
})
export type VmConfig = z.infer<typeof VmConfig>

export const DEFAULT_VM_CONFIG: VmConfig = { cpus: 4, memGb: 8, dataGb: 60, systemGb: 40 }

export const VmLifecycleState = VmState.exclude(['suspended'])
export type VmLifecycleState = z.infer<typeof VmLifecycleState>

export const VmInfo = z.object({
  state: VmLifecycleState,
  config: VmConfig,
  /** Human-readable reason when `state` is `error`. */
  error: z.string().optional(),
  /** Machine code of the error (`GOLDEN_NOT_FOUND`, `PORT_IN_USE`, `BOOT_TIMEOUT`...). */
  errorCode: z.string().optional(),
  /** First port of the workspace's range: the guest agent on it, VNC of display N on portBase + N. */
  portBase: z.number().int().nullable(),
  desktops: z.number().int().nonnegative(),
  phase: z.enum(['creating', 'booting', 'provisioning']).optional(),
  /**
   * System image of a created VM: its golden `revision` and the one this app version builds
   * (`latestRevision`); a lower revision means a system update is available.
   */
  system: z
    .object({
      goldenVersion: z.string().nullable(),
      revision: z.number().int().positive(),
      latestRevision: z.number().int().positive(),
    })
    .optional(),
})
export type VmInfo = z.infer<typeof VmInfo>

export const VmAccelKind = z.enum(['hvf', 'kvm', 'whpx', 'tcg']) satisfies z.ZodType<VmAccel>
export type VmAccelKind = z.infer<typeof VmAccelKind>

/**
 * Linux hardware acceleration: `ok` (the user can open `/dev/kvm`), `no_device` (no `/dev/kvm`:
 * virtualization off or KVM missing), `no_permission` (not in the `kvm` group), `relogin` (added to
 * the group, but the daemon's session started before).
 */
export const KvmStatus = z.enum(['ok', 'no_device', 'no_permission', 'relogin'])
export type KvmStatus = z.infer<typeof KvmStatus>

/** What the host needs for the VM to run at full speed, for the setup's machine step (QEMU ships with the app). */
export const HostSetup = z.object({
  /** Linux only. */
  kvm: z.object({ status: KvmStatus, fixCommand: z.string().nullable() }).nullable(),
})
export type HostSetup = z.infer<typeof HostSetup>

export const HostInfo = z.object({
  cpus: z.number().int().positive(),
  memoryGb: z.number().int().positive(),
  maxVmCpus: z.number().int().positive(),
  maxVmMemoryGb: z.number().int().positive(),
  goldenImage: z.object({ bytes: z.number().int(), version: z.string().nullable() }).nullable(),
  /**
   * The QEMU shipped with the app (else a system one: dev), `qemu-system-*` (aarch64 or x86_64, see
   * `vmProfile`), `qemu-img` and UEFI firmware; `found` needs all three. `path` is the former's, `binary` its
   * name; `firmware.tried` lists the firmware code files looked for.
   */
  qemu: z.object({
    found: z.boolean(),
    path: z.string().nullable(),
    binary: z.string().optional(),
    firmware: z.object({ found: z.boolean(), tried: z.array(z.string()) }).optional(),
  }),
  /** `process.platform`/`process.arch`. */
  platform: z.object({ os: z.string(), arch: z.string() }).optional(),
  /**
   * Where secrets live: `keychain` (macOS), `keyring` (Secret Service / Credential Manager),
   * `encrypted_file` (encrypted file in the data folder, used when no OS keyring is usable: the interface
   * warns about it), `memory` (tests/dev).
   */
  secretStore: z.enum(['keychain', 'keyring', 'encrypted_file', 'memory']).optional(),
  /**
   * `keyring_unreachable`: the OS keyring that holds this data folder's secrets did not answer at startup
   * (locked, or its service not running yet). Secrets stay there, so they fail until it answers.
   */
  secretStoreWarning: z.enum(['keyring_unreachable']).optional(),
  /**
   * VM acceleration: `kind` is what the VM will use; `slow` = software emulation (TCG), shown as a
   * warning. `reason`: `kvm_unavailable` (Linux: no /dev/kvm or no access, e.g. user not in the `kvm`
   * group), `hvf_unavailable`; on Windows `whpx_feature_disabled` (Windows Hypervisor Platform feature
   * off), `whpx_reboot_pending` (feature on, reboot needed), `virtualization_disabled` (VT-x/AMD-V off in
   * the firmware) and `whpx_unavailable` (generic: WHPX failed without a known cause). Checked on every
   * call, so "check again" sees the current state; present even when QEMU is missing.
   */
  vmAccel: z
    .object({
      kind: VmAccelKind,
      preferred: VmAccelKind.exclude(['tcg']),
      slow: z.boolean(),
      reason: z.string().nullable(),
    })
    .optional(),
  /** Checked on every call, like `vmAccel`. */
  setup: HostSetup.optional(),
})
export type HostInfo = z.infer<typeof HostInfo>

export const VmDiskUsage = z.object({
  /** What the guest sees (the limit). */
  virtualBytes: z.number().int(),
  /** What the qcow2 file takes on the host (grows with use). */
  actualBytes: z.number().int().nullable(),
})
export type VmDiskUsage = z.infer<typeof VmDiskUsage>

export const VmSnapshot = z.object({ name: z.string(), createdAt: z.number().int().nullable() })
export type VmSnapshot = z.infer<typeof VmSnapshot>

export const VmTaskKind = z.enum([
  'restart',
  'grow_disk',
  'snapshot_create',
  'snapshot_restore',
  'snapshot_delete',
  'reset',
  'update_system',
])
export type VmTaskKind = z.infer<typeof VmTaskKind>

/** Long VM operation (stops the VM, changes disks, boots again). */
export const VmTask = z.object({
  kind: VmTaskKind,
  status: z.enum(['waiting_idle', 'running', 'done', 'error']),
  error: z.string().nullable(),
  startedAt: z.number().int(),
  finishedAt: z.number().int().nullable(),
})
export type VmTask = z.infer<typeof VmTask>

/**
 * A requested system update that has not started yet; other VM operations run meanwhile. Once it
 * starts it is the `task` (`update_system`).
 */
export const VmSystemUpdate = z.object({
  /** `waiting_golden`: the new golden image is being built; `waiting_task`: another VM operation runs. */
  status: z.enum(['waiting_golden', 'waiting_idle', 'waiting_task']),
  whenIdle: z.boolean(),
  requestedAt: z.number().int(),
})
export type VmSystemUpdate = z.infer<typeof VmSystemUpdate>

export const VmDetails = z.object({
  vm: VmInfo,
  /** What the running VM booted with. */
  running: z.object({ cpus: z.number().int(), memGb: z.number().int() }).nullable(),
  startedAt: z.number().int().nullable(),
  /** The configured CPUs/memory differ from the running VM's: they apply on the next boot. */
  pendingRestart: z.boolean(),
  disks: z.object({ system: VmDiskUsage.nullable(), data: VmDiskUsage.nullable() }),
  snapshots: z.array(VmSnapshot),
  workingBots: z.number().int().nonnegative(),
  task: VmTask.nullable(),
  systemUpdate: VmSystemUpdate.nullable(),
})
export type VmDetails = z.infer<typeof VmDetails>

/** Inside the guest's filesystem (not the qcow2 on the host). */
export const VmStatsDisk = z.object({ usedBytes: z.number(), totalBytes: z.number() })
export type VmStatsDisk = z.infer<typeof VmStatsDisk>

export const VmStatsSample = z.object({ at: z.number(), cpuPercent: z.number(), memoryUsedBytes: z.number() })
export type VmStatsSample = z.infer<typeof VmStatsSample>

/** Sampled by the runtime every few seconds; history kept only in memory. */
export const VmStats = z.object({
  at: z.number(),
  intervalSec: z.number(),
  uptimeSec: z.number(),
  cpus: z.number().int(),
  loadavg: z.array(z.number()),
  /** 0–100 of every CPU of the VM. */
  cpuPercent: z.number(),
  /** `usedBytes` = total − available; `cacheBytes` is page cache the kernel gives back on demand. */
  memory: z.object({ totalBytes: z.number(), usedBytes: z.number(), cacheBytes: z.number() }),
  disks: z.object({ system: VmStatsDisk.nullable(), data: VmStatsDisk.nullable() }),
  /** Programs of each bot (its slice + login slice); `cpuPercent` of the whole VM. */
  bots: z.array(z.object({ botId: z.string(), cpuPercent: z.number(), memoryBytes: z.number() })),
  other: z.object({ cpuPercent: z.number(), memoryBytes: z.number() }),
  /** Oldest first; the last one is this sample. */
  history: z.array(VmStatsSample),
})
export type VmStats = z.infer<typeof VmStats>

/** `null` while the VM is not running or before the second sample (CPU needs two). */
export const VmStatsResponse = z.object({ stats: VmStats.nullable() })
export type VmStatsResponse = z.infer<typeof VmStatsResponse>

const UpdateVmResourcesBody = z.object({
  cpus: z.number().int().min(1).max(64).optional(),
  memGb: z.number().int().min(2).max(512).optional(),
})

const RestartVmBody = z.object({ whenIdle: z.boolean().default(true) })

const UpdateVmSystemBody = z.object({ whenIdle: z.boolean().default(true) })

export const VmDiskKind = z.enum(['system', 'data'])
export type VmDiskKind = z.infer<typeof VmDiskKind>

const GrowVmDiskBody = z.object({ disk: VmDiskKind, sizeGb: z.number().int().min(1).max(4096) })

export const SNAPSHOT_NAME_PATTERN = /^[A-Za-z0-9._-]{1,64}$/
const CreateVmSnapshotBody = z.object({
  name: z.string().regex(SNAPSHOT_NAME_PATTERN).optional(),
})

export const vmEndpoints = {
  getHostInfo: endpoint({ method: 'GET', path: '/host', response: HostInfo }),
  getVm: endpoint({ method: 'GET', path: '/w/:workspaceId/vm', response: VmInfo }),
  /** Creates the VM on first use; returns at once, progress arrives as `vm.status`. */
  startVm: endpoint({ method: 'POST', path: '/w/:workspaceId/vm/start', response: VmInfo }),
  stopVm: endpoint({ method: 'POST', path: '/w/:workspaceId/vm/stop', response: VmInfo }),
  /** Recreates the system disk from the golden image (data disk kept) and re-provisions bots. */
  resetVm: endpoint({ method: 'POST', path: '/w/:workspaceId/vm/reset', response: VmInfo }),
  getVmDetails: endpoint({ method: 'GET', path: '/w/:workspaceId/vm/details', response: VmDetails }),
  /** Polled by the app while it is on screen. */
  getVmStats: endpoint({ method: 'GET', path: '/w/:workspaceId/vm/stats', response: VmStatsResponse }),
  /** Applies on the next boot. */
  updateVmResources: endpoint({
    method: 'PATCH',
    path: '/w/:workspaceId/vm/resources',
    body: UpdateVmResourcesBody,
    response: VmDetails,
  }),
  /** Restarts the VM, by default once every bot is idle. Progress: `task` of the details + `vm.status`. */
  restartVm: endpoint({
    method: 'POST',
    path: '/w/:workspaceId/vm/restart',
    body: RestartVmBody,
    response: VmDetails,
  }),
  /**
   * Moves the VM to the newest system image, keeping the data disk (like a reset). Waits for the
   * image this app version builds (start its build with `buildGoldenImage`), then for idle bots when
   * `whenIdle`; the request survives runtime restarts until it runs or is cancelled.
   */
  updateVmSystem: endpoint({
    method: 'POST',
    path: '/w/:workspaceId/vm/update-system',
    body: UpdateVmSystemBody,
    response: VmDetails,
  }),
  /** Only one still waiting (image or idle bots). */
  cancelVmSystemUpdate: endpoint({
    method: 'POST',
    path: '/w/:workspaceId/vm/update-system/cancel',
    response: VmDetails,
  }),
  /** Grows a disk (never shrinks); a running VM is stopped and booted again. */
  growVmDisk: endpoint({
    method: 'POST',
    path: '/w/:workspaceId/vm/disks/grow',
    body: GrowVmDiskBody,
    response: VmDetails,
  }),
  /** Restore point of the system disk; a running VM is stopped and booted again. */
  createVmSnapshot: endpoint({
    method: 'POST',
    path: '/w/:workspaceId/vm/snapshots',
    body: CreateVmSnapshotBody,
    response: VmDetails,
  }),
  restoreVmSnapshot: endpoint({
    method: 'POST',
    path: '/w/:workspaceId/vm/snapshots/:name/restore',
    response: VmDetails,
  }),
  deleteVmSnapshot: endpoint({
    method: 'DELETE',
    path: '/w/:workspaceId/vm/snapshots/:name',
    response: VmDetails,
  }),
}
