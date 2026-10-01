import { z } from 'zod'

import { endpoint, Ok } from '../http/endpoint'
import { type VmConfig, VmInfo } from '../vm/vm'
import { SetupStep, WorkspaceSummary } from './workspace'

const SETUP_TRANSITIONS: Record<SetupStep, SetupStep[]> = {
  providers: ['vm'],
  vm: ['login', 'done'],
  // Back to how the bots think (e.g. a CLI engine picked by mistake): the machine is kept.
  login: ['done', 'providers'],
  done: [],
}

export function isSetupTransitionAllowed(from: SetupStep, to: SetupStep): boolean {
  return from === to || SETUP_TRANSITIONS[from].includes(to)
}

/** Step that follows `step`; the logins only happen when a CLI engine runs on a subscription. */
export function nextSetupStep(step: SetupStep, context: { needsLogin: boolean }): SetupStep {
  switch (step) {
    case 'providers':
      return 'vm'
    case 'vm':
      return context.needsLogin ? 'login' : 'done'
    default:
      return 'done'
  }
}

export const VmPresetId = z.enum(['light', 'recommended', 'powerful'])
export type VmPresetId = z.infer<typeof VmPresetId>

export type VmSize = Pick<VmConfig, 'cpus' | 'memGb' | 'dataGb'>

export const VM_PRESETS: ReadonlyArray<{ id: VmPresetId } & VmSize> = [
  { id: 'light', cpus: 2, memGb: 4, dataGb: 40 },
  { id: 'recommended', cpus: 4, memGb: 8, dataGb: 60 },
  { id: 'powerful', cpus: 8, memGb: 16, dataGb: 80 },
]

export const VM_SIZE_LIMITS = {
  minCpus: 1,
  minMemGb: 2,
  minDataGb: 20,
  maxDataGb: 500,
  dataStepGb: 10,
} as const

export interface VmHostLimits {
  maxVmCpus: number
  maxVmMemoryGb: number
}

export function presetFits(size: VmSize, host: VmHostLimits): boolean {
  return size.cpus <= host.maxVmCpus && size.memGb <= host.maxVmMemoryGb
}

/** Recommended when the host can run it, else the largest preset that fits (null: none fits). */
export function defaultPreset(host: VmHostLimits): VmPresetId | null {
  const recommended = VM_PRESETS.find((p) => p.id === 'recommended')
  if (recommended && presetFits(recommended, host)) return 'recommended'
  const fitting = VM_PRESETS.filter((p) => presetFits(p, host))
  return fitting.at(-1)?.id ?? null
}

export function matchPreset(size: VmSize): VmPresetId | null {
  return (
    VM_PRESETS.find((p) => p.cpus === size.cpus && p.memGb === size.memGb && p.dataGb === size.dataGb)?.id ??
    null
  )
}

export function clampVmSize(size: VmSize, host: VmHostLimits): VmSize {
  const clamp = (value: number, min: number, max: number) => Math.min(Math.max(Math.round(value), min), max)
  const dataGb = clamp(size.dataGb, VM_SIZE_LIMITS.minDataGb, VM_SIZE_LIMITS.maxDataGb)
  return {
    cpus: clamp(size.cpus, VM_SIZE_LIMITS.minCpus, Math.max(VM_SIZE_LIMITS.minCpus, host.maxVmCpus)),
    memGb: clamp(size.memGb, VM_SIZE_LIMITS.minMemGb, Math.max(VM_SIZE_LIMITS.minMemGb, host.maxVmMemoryGb)),
    dataGb: Math.round(dataGb / VM_SIZE_LIMITS.dataStepGb) * VM_SIZE_LIMITS.dataStepGb,
  }
}

export const GoldenBuildStage = z.enum(['download', 'install', 'save'])
export type GoldenBuildStage = z.infer<typeof GoldenBuildStage>

export const GoldenStatus = z.object({
  state: z.enum(['ready', 'missing', 'building', 'failed']),
  stage: GoldenBuildStage.nullable(),
  percent: z.number().min(0).max(100),
  /** Of the Debian base image being downloaded, when known. */
  downloadBytes: z.number().int().nullable(),
  etaSeconds: z.number().int().nonnegative().nullable(),
  startedAt: z.number().int().nullable(),
  error: z.string().nullable(),
  /** Revision of the current golden image (null: missing). */
  revision: z.number().int().positive().nullable(),
  /** Revision this app version builds; a lower `revision` is `outdated` (`buildGoldenImage` rebuilds it). */
  latestRevision: z.number().int().positive(),
  outdated: z.boolean(),
})
export type GoldenStatus = z.infer<typeof GoldenStatus>

export const SetupVmBody = z.object({
  cpus: z.number().int().positive().max(128),
  memGb: z.number().int().positive().max(1024),
  dataGb: z.number().int().min(VM_SIZE_LIMITS.minDataGb).max(VM_SIZE_LIMITS.maxDataGb),
})
export type SetupVmBody = z.input<typeof SetupVmBody>

/** Runtime side of `setupWorkspaceVm`: stores the size and boots when the golden image exists. */
const ConfigureSetupVmBody = SetupVmBody.extend({ start: z.boolean() })

const UpdateSetupBody = z.object({ step: SetupStep })

const CheckOpenRouterKeyBody = z.object({ apiKey: z.string().trim().min(1) })

export const OpenRouterKeyCheck = z.object({
  valid: z.boolean(),
  creditUsd: z.number().nullable(),
  error: z.string().nullable(),
})
export type OpenRouterKeyCheck = z.infer<typeof OpenRouterKeyCheck>

export const setupEndpoints = {
  getGoldenImage: endpoint({ method: 'GET', path: '/golden', response: GoldenStatus }),
  /** In the background; no-op while building or when it exists. */
  buildGoldenImage: endpoint({ method: 'POST', path: '/golden/build', response: GoldenStatus }),
  /** Saves the VM size and creates the VM (building the golden image first when missing). */
  setupWorkspaceVm: endpoint({
    method: 'POST',
    path: '/workspaces/:workspaceId/setup/vm',
    body: SetupVmBody,
    response: WorkspaceSummary,
  }),
  /** Moves the setup forward; `done` lets the first bot introduce itself. */
  updateWorkspaceSetup: endpoint({
    method: 'PATCH',
    path: '/workspaces/:workspaceId/setup',
    body: UpdateSetupBody,
    response: WorkspaceSummary,
  }),

  configureSetupVm: endpoint({
    method: 'POST',
    path: '/w/:workspaceId/setup/vm',
    body: ConfigureSetupVmBody,
    response: VmInfo,
  }),
  finishSetup: endpoint({ method: 'POST', path: '/w/:workspaceId/setup/finish', response: Ok }),
  checkOpenRouterKey: endpoint({
    method: 'POST',
    path: '/w/:workspaceId/setup/openrouter-key',
    body: CheckOpenRouterKeyBody,
    response: OpenRouterKeyCheck,
  }),
}
