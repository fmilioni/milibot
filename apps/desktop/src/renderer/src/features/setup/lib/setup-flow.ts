import {
  clampVmSize,
  CLI_ENGINES,
  type CliEngine,
  type ComputerKind,
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

/** Why the setup starts on "no computer": no QEMU to run a VM, no hardware acceleration, or too little memory. */
type NoComputerReason = 'qemu' | 'slow' | 'memory'

export type ComputerSuggestion = { kind: 'vm' } | { kind: 'none'; reason: NoComputerReason }

/** The computer step 1 starts on: a VM unless this host can't run one well. Null until the host is known. */
export function suggestedComputer(host: HostInfo | null): ComputerSuggestion | null {
  if (!host) {
    return null
  }

  if (!host.qemu.found) {
    return { kind: 'none', reason: 'qemu' }
  }

  if (host.vmAccel?.slow) {
    return { kind: 'none', reason: 'slow' }
  }

  if (defaultPreset(host) === null) {
    return { kind: 'none', reason: 'memory' }
  }

  return { kind: 'vm' }
}

/**
 * The computer the setup works with: the stored one once step 1 was saved; on step 1, the user's pick, a VM
 * already running (back from a login, so it was chosen before), or the host's suggestion.
 */
export function setupComputerKind(input: {
  step: SetupStep
  stored: ComputerKind | null
  chosen: ComputerKind | null
  vm: VmInfo | null
  suggested: ComputerKind | null
}): ComputerKind {
  if (input.step !== 'providers' && input.stored) {
    return input.stored
  }

  if (input.chosen) {
    return input.chosen
  }

  if (input.vm?.state === 'running') {
    return 'vm'
  }

  return input.suggested ?? 'vm'
}

export interface VmStepInput {
  step: SetupStep
  /** The workspace's computer, stored when step 1 is saved. */
  computer: ComputerKind
  vm: VmInfo | null
  golden: GoldenStatus | null
  /** The providers were read (they decide whether logins follow). */
  providers: Provider[] | null
}

/**
 * The computer is ready during step 2 (a VM once it runs; no computer right away): the setup moves on to the
 * logins, or straight to the first bot.
 */
export function vmStepAdvance({ step, computer, vm, providers }: VmStepInput): SetupStep | null {
  const computerReady = computer !== 'vm' || vm?.state === 'running'
  if (step !== 'vm' || !computerReady || !providers) {
    return null
  }

  return nextSetupStep('vm', { needsLogin: loginEngines(providers).length > 0 })
}

/** Resuming step 2 with the image ready but the VM not started (e.g. the daemon restarted meanwhile). */
export function vmStepNeedsStart({ step, computer, vm, golden }: VmStepInput): boolean {
  if (step !== 'vm' || computer !== 'vm' || !goldenReadyForSetup(golden) || !vm) {
    return false
  }

  return (
    vm.state === 'not_created' ||
    vm.state === 'stopped' ||
    (vm.state === 'error' && vm.errorCode === 'GOLDEN_NOT_FOUND')
  )
}

/** Step 2 waits on an image nothing builds (e.g. the build died with the daemon). */
export function vmStepNeedsBuild({ step, computer, vm, golden }: VmStepInput): boolean {
  return step === 'vm' && computer === 'vm' && goldenBuildStalled(golden, vm)
}
