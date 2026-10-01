import {
  clampVmSize,
  CLI_ENGINES,
  type CliEngine,
  DEFAULT_VM_CONFIG,
  defaultPreset,
  type GoldenStatus,
  type HostInfo,
  nextSetupStep,
  type Provider,
  type SetupStep,
  VM_PRESETS,
  type VmInfo,
  type VmSize,
} from '@milibot/shared'

import {
  effectiveDefault,
  goldenBuildStalled,
  goldenReadyForSetup,
  type ProviderRowId,
  type ProviderStepState,
  rowOf,
} from './setup'

/** One write of step 1's save, in order. */
type ProviderSaveOp =
  | { op: 'remove'; providerId: string }
  | { op: 'createCli'; engine: CliEngine }
  /**
   * Creates OpenRouter with the key, or stores a new key on the existing one (null: keeps it); then picks
   * its default model when it has none.
   */
  | { op: 'openRouter'; existing: Provider | null; apiKey: string | null }

export interface ProviderSavePlan {
  ops: ProviderSaveOp[]
  /** Providers already there per checked row; created ones are added as the ops run. */
  ids: Partial<Record<ProviderRowId, string>>
  /** Row whose provider becomes the workspace default. */
  defaultRow: ProviderRowId | null
}

/** What saving step 1 writes: the checked rows get a provider, the unchecked ones lose theirs. */
export function planProviderSave(state: ProviderStepState, providers: Provider[]): ProviderSavePlan {
  const of = (row: ProviderRowId) => providers.filter((p) => rowOf(p) === row)
  const removeAll = (row: ProviderRowId): ProviderSaveOp[] =>
    of(row).map((p) => ({ op: 'remove', providerId: p.id }))
  const ops: ProviderSaveOp[] = []
  const ids: Partial<Record<ProviderRowId, string>> = {}

  for (const engine of CLI_ENGINES) {
    if (!state.checked[engine]) ops.push(...removeAll(engine))
    else {
      const existing = of(engine)[0]
      if (existing) ids[engine] = existing.id
      else ops.push({ op: 'createCli', engine })
    }
  }

  if (state.checked.openrouter) {
    const existing = of('openrouter')[0] ?? null
    ops.push({ op: 'openRouter', existing, apiKey: state.openRouterKey.trim() || null })
  } else ops.push(...removeAll('openrouter'))

  if (state.checked.compatible) {
    const id = state.compatibleIds[0]
    if (id) ids.compatible = id
  } else ops.push(...removeAll('compatible'))

  return { ops, ids, defaultRow: effectiveDefault(state) }
}

/** CLI engines signed in with a subscription: their logins come after the VM, one after the other. */
export function loginEngines(providers: Provider[] | null): CliEngine[] {
  return CLI_ENGINES.filter((engine) =>
    (providers ?? []).some((p) => p.type === engine && (p.authMode ?? 'subscription') === 'subscription'),
  )
}

/**
 * The size step 2 starts on: the one copied from another workspace (a VM config that is not the default
 * and fits this host), else the host's preset. Null until the host is known and the VM had a moment to load.
 */
export function initialVmSize(host: HostInfo | null, vm: VmInfo | null, vmWaitOver: boolean): VmSize | null {
  if (!host || (!vm && !vmWaitOver)) return null
  const preset = VM_PRESETS.find((p) => p.id === defaultPreset(host)) ?? VM_PRESETS[0]!
  const configured = vm?.config
  const copied =
    configured &&
    !(
      configured.cpus === DEFAULT_VM_CONFIG.cpus &&
      configured.memGb === DEFAULT_VM_CONFIG.memGb &&
      configured.dataGb === DEFAULT_VM_CONFIG.dataGb
    ) &&
    configured.cpus <= host.maxVmCpus
  const initial = copied
    ? { cpus: configured.cpus, memGb: configured.memGb, dataGb: configured.dataGb }
    : { cpus: preset.cpus, memGb: preset.memGb, dataGb: preset.dataGb }
  return clampVmSize(initial, host)
}

export interface VmStepInput {
  step: SetupStep
  vm: VmInfo | null
  golden: GoldenStatus | null
  /** The providers were read (they decide whether logins follow). */
  providers: Provider[] | null
}

/** The VM is up during step 2: the setup moves on to the logins, or straight to the first bot. */
export function vmStepAdvance({ step, vm, providers }: VmStepInput): SetupStep | null {
  if (step !== 'vm' || vm?.state !== 'running' || !providers) return null
  return nextSetupStep('vm', { needsLogin: loginEngines(providers).length > 0 })
}

/** Resuming step 2 with the image ready but the VM not started (e.g. the daemon restarted meanwhile). */
export function vmStepNeedsStart({ step, vm, golden }: VmStepInput): boolean {
  if (step !== 'vm' || !goldenReadyForSetup(golden) || !vm) return false
  return (
    vm.state === 'not_created' ||
    vm.state === 'stopped' ||
    (vm.state === 'error' && vm.errorCode === 'GOLDEN_NOT_FOUND')
  )
}

/** Step 2 waits on an image nothing builds (e.g. the build died with the daemon). */
export function vmStepNeedsBuild({ step, vm, golden }: VmStepInput): boolean {
  return step === 'vm' && goldenBuildStalled(golden, vm)
}
