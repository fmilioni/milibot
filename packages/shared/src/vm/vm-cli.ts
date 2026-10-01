// Contract between the daemon and the workspace VM CLI (vm/host): the VM's `config.json` and what each
// command prints. The CLI imports only the types (plain Node never loads this file); the daemon parses.
import { z } from 'zod'

export const VmCliErrorBody = z.object({
  ok: z.literal(false),
  error: z.object({ code: z.string(), message: z.string() }),
})
export type VmCliErrorBody = z.infer<typeof VmCliErrorBody>

/** What `start` records for the running QEMU (resize applies on the next boot). */
export const VmRunningRecord = z.object({
  pid: z.number().int(),
  cpus: z.number().int(),
  memGb: z.number(),
  accel: z.string().optional(),
  /** The `-accel` value (e.g. `whpx,kernel-irqchip=off`). */
  accelArg: z.string().optional(),
  startedAt: z.string().optional(),
})
export type VmRunningRecord = z.infer<typeof VmRunningRecord>

export const VmSavedFirmware = z.object({ code: z.string(), vars: z.string(), codeSize: z.number() })
export type VmSavedFirmware = z.infer<typeof VmSavedFirmware>

/** `<wsDir>/vm/config.json`, written by the CLI (unknown keys are kept on rewrite). */
export const VmConfigFile = z.looseObject({
  version: z.number().int(),
  name: z.string(),
  hostname: z.string(),
  instanceId: z.string(),
  cpus: z.number().int(),
  memGb: z.number().int(),
  systemGb: z.number().int(),
  dataGb: z.number().int(),
  portBase: z.number().int(),
  /** Versioned golden image the system disk is backed by. */
  golden: z.string(),
  goldenVersion: z.string().nullable(),
  macAddress: z.string(),
  createdAt: z.string(),
  firmware: VmSavedFirmware,
  whpxKernelIrqchip: z.enum(['on', 'off']).optional(),
  systemResetAt: z.string().optional(),
  running: VmRunningRecord.optional(),
})
export type VmConfigFile = z.infer<typeof VmConfigFile>

/** What the daemon needs from `config.json`; a malformed `running` record only means "not known". */
export const VmConfigFileView = VmConfigFile.pick({
  cpus: true,
  memGb: true,
  systemGb: true,
  dataGb: true,
  portBase: true,
}).extend({
  golden: z.string().optional().catch(undefined),
  running: VmRunningRecord.optional().catch(undefined),
})
export type VmConfigFileView = z.infer<typeof VmConfigFileView>

export const VmCliPorts = z.object({
  agent: z.number().int(),
  vncFirst: z.number().int(),
  vncLast: z.number().int(),
  vncForDisplay: z.string(),
})
export type VmCliPorts = z.infer<typeof VmCliPorts>

export const VmCliSnapshot = z.object({ id: z.string(), name: z.string(), date: z.string() })
export type VmCliSnapshot = z.infer<typeof VmCliSnapshot>

export const VmCliDisk = z.discriminatedUnion('exists', [
  z.object({ path: z.string(), exists: z.literal(false) }),
  z.object({
    path: z.string(),
    exists: z.literal(true),
    virtualBytes: z.number(),
    actualBytes: z.number().nullable(),
    backingFile: z.string().optional(),
    snapshots: z.array(VmCliSnapshot),
  }),
])
export type VmCliDisk = z.infer<typeof VmCliDisk>

export const VmCliCreateResult = z.object({
  ok: z.literal(true),
  created: z.literal(true),
  vmDir: z.string(),
  config: VmConfigFile,
  ports: VmCliPorts,
  tokenFile: z.string(),
})
export type VmCliCreateResult = z.infer<typeof VmCliCreateResult>

export const VmCliStatus = z.object({
  ok: z.literal(true),
  name: z.string(),
  state: z.enum(['running', 'stopped']),
  pid: z.number().int().nullable(),
  qmpStatus: z.string().nullable(),
  agentReachable: z.boolean(),
  agentUrl: z.string(),
  tokenFile: z.string(),
  ports: VmCliPorts,
  cpus: z.number().int(),
  memGb: z.number().int(),
  golden: z.object({ path: z.string(), version: z.string().nullable(), exists: z.boolean() }),
  currentGolden: z.string().nullable(),
  running: VmRunningRecord.nullable(),
  accel: z.object({ kind: z.string(), slow: z.boolean(), reason: z.string().nullable() }),
  disks: z.object({ system: VmCliDisk, data: VmCliDisk }),
  vmDir: z.string(),
})
export type VmCliStatus = z.infer<typeof VmCliStatus>

export const VmCliStartResult = z.object({
  ok: z.literal(true),
  started: z.literal(true),
  pid: z.number().int(),
  accel: z.string(),
  accelArg: z.string(),
  /** Software emulation (TCG). */
  slow: z.boolean(),
  reason: z.string().nullable(),
  fallback: z.enum(['tcg', 'kernel_irqchip_off']).nullable(),
  whpxKernelIrqchip: z.enum(['default', 'on', 'off']).nullable(),
  whpxKernelIrqchipForced: z.boolean(),
  ports: VmCliPorts,
  agentReady: z.boolean().optional(),
  bootMs: z.number().optional(),
})
export type VmCliStartResult = z.infer<typeof VmCliStartResult>

/** `start` on a VM already running answers with its status. */
export const VmCliStartOutput = z.union([
  VmCliStartResult,
  VmCliStatus.extend({ alreadyRunning: z.literal(true) }),
])
export type VmCliStartOutput = z.infer<typeof VmCliStartOutput>

export const VmCliStopResult = z.union([
  z.object({ ok: z.literal(true), state: z.literal('stopped'), alreadyStopped: z.literal(true) }),
  z.object({
    ok: z.literal(true),
    state: z.literal('stopped'),
    method: z.enum(['acpi', 'quit', 'timeout-quit', 'kill', 'sigkill']),
    stopMs: z.number(),
  }),
])
export type VmCliStopResult = z.infer<typeof VmCliStopResult>

export const VmCliResetResult = z.object({
  ok: z.literal(true),
  reset: z.literal(true),
  stoppedFirst: z.boolean(),
  golden: z.string(),
  previousGolden: z.string(),
})
export type VmCliResetResult = z.infer<typeof VmCliResetResult>

export const VmCliSnapshotResult = z.union([
  z.object({ ok: z.literal(true), snapshots: z.array(VmCliSnapshot) }),
  z.object({
    ok: z.literal(true),
    action: z.enum(['create', 'restore', 'delete']),
    name: z.string(),
    snapshots: z.array(VmCliSnapshot),
  }),
])
export type VmCliSnapshotResult = z.infer<typeof VmCliSnapshotResult>

export const VmCliResizeResult = z.object({
  ok: z.literal(true),
  cpus: z.number().int(),
  memGb: z.number().int(),
  portBase: z.number().int(),
  ports: VmCliPorts,
  appliesOnNextBoot: z.literal(true),
  running: z.boolean(),
})
export type VmCliResizeResult = z.infer<typeof VmCliResizeResult>

export const VmCliGrowDiskResult = z.object({
  ok: z.literal(true),
  disk: z.enum(['system', 'data']),
  previousBytes: z.number(),
  virtualBytes: z.number(),
  changed: z.boolean(),
})
export type VmCliGrowDiskResult = z.infer<typeof VmCliGrowDiskResult>

/** A QMP reply passed through (`ok` is false when QEMU answered with an error). */
export const VmCliQmpResult = z.looseObject({ ok: z.boolean() })
export type VmCliQmpResult = z.infer<typeof VmCliQmpResult>
