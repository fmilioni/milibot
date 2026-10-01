import {
  CLI_ENGINE_INFO,
  CLI_ENGINES,
  type CliEngine,
  type CliLoginStatus,
  type GoldenStatus,
  type HostInfo,
  isCliEngine,
  type Provider,
  type VmInfo,
} from '@milibot/shared'
import type { TFunction } from 'i18next'

import { isOpenRouter } from '@/features/providers/lib/provider-form'

/** A CLI engine's row, then OpenRouter's and the OpenAI-compatible providers'. */
export type ProviderRowId = CliEngine | 'openrouter' | 'compatible'
export const PROVIDER_ROWS: ProviderRowId[] = [...CLI_ENGINES, 'openrouter', 'compatible']
/** Checked (and the default) when the workspace has no provider yet. */
const FIRST_ROW: ProviderRowId = PROVIDER_ROWS[0] ?? 'openrouter'

/** A row's name: the engine's brand, else its translated name. */
export function providerRowName(t: TFunction, row: ProviderRowId): string {
  if (isCliEngine(row)) return CLI_ENGINE_INFO[row].displayName
  return t(row === 'openrouter' ? 'setup.providers.openRouter.name' : 'setup.providers.compatible.name')
}

type KeyCheck =
  | { status: 'empty' }
  | { status: 'checking' }
  | { status: 'valid'; creditUsd: number | null }
  | { status: 'invalid' }
  | { status: 'unreachable' }
  /** A key already stored for the provider (e.g. copied from another workspace). */
  | { status: 'saved' }

export interface ProviderStepState {
  checked: Record<ProviderRowId, boolean>
  openRouterKey: string
  openRouterCheck: KeyCheck
  /** Providers configured through the provider form (OpenAI-compatible or Anthropic). */
  compatibleIds: string[]
  defaultRow: ProviderRowId | null
}

export type ProviderStepIssue = 'none_selected' | 'openrouter_key' | 'compatible_missing'

export function rowOf(provider: Pick<Provider, 'type' | 'preset' | 'baseUrl'>): ProviderRowId {
  if (isCliEngine(provider.type)) return provider.type
  return isOpenRouter(provider) ? 'openrouter' : 'compatible'
}

/** Initial state of the step from the workspace's providers (copied from another workspace or saved before). */
export function initialProviderStep(providers: Provider[]): ProviderStepState {
  const rows = new Set(providers.map(rowOf))
  const openRouter = providers.find((p) => rowOf(p) === 'openrouter')
  const fallbackDefault = providers.find((p) => p.isDefault)
  const empty = providers.length === 0
  return {
    checked: Object.fromEntries(
      PROVIDER_ROWS.map((row) => [row, rows.has(row) || (empty && row === FIRST_ROW)]),
    ) as Record<ProviderRowId, boolean>,
    openRouterKey: '',
    openRouterCheck: openRouter?.hasSecret ? { status: 'saved' } : { status: 'empty' },
    compatibleIds: providers.filter((p) => rowOf(p) === 'compatible').map((p) => p.id),
    defaultRow: fallbackDefault ? rowOf(fallbackDefault) : empty ? FIRST_ROW : null,
  }
}

export function checkedRows(state: ProviderStepState): ProviderRowId[] {
  return PROVIDER_ROWS.filter((row) => state.checked[row])
}

/** The chosen default when it is still checked, else the first checked row. */
export function effectiveDefault(state: ProviderStepState): ProviderRowId | null {
  const rows = checkedRows(state)
  return state.defaultRow && rows.includes(state.defaultRow) ? state.defaultRow : (rows[0] ?? null)
}

export function providerStepIssues(state: ProviderStepState): ProviderStepIssue[] {
  const issues: ProviderStepIssue[] = []
  if (checkedRows(state).length === 0) issues.push('none_selected')
  if (state.checked.openrouter && !['valid', 'saved'].includes(state.openRouterCheck.status))
    issues.push('openrouter_key')
  if (state.checked.compatible && state.compatibleIds.length === 0) issues.push('compatible_missing')
  return issues
}

/** A pasted OpenRouter key worth checking (the check itself runs on the daemon). */
export function looksLikeOpenRouterKey(key: string): boolean {
  return /^sk-or-[\w-]{10,}$/.test(key.trim())
}

/** `sk-or-••••3f9a` */
export function maskKey(key: string): string {
  const trimmed = key.trim()
  if (trimmed.length <= 10) return trimmed
  return `${trimmed.slice(0, 6)}••••${trimmed.slice(-4)}`
}

interface ModelLike {
  modelId: string
  supportsTools: boolean
  supportsVision: boolean
  enabled?: boolean
}

function versionKey(modelId: string): number[] {
  return (modelId.match(/\d+(?:\.\d+)?/g) ?? []).flatMap((n) => n.split('.').map(Number))
}

function compareVersions(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const diff = (a[i] ?? -1) - (b[i] ?? -1)
    if (diff !== 0) return diff
  }
  return 0
}

/** Default model of a new OpenRouter provider: the newest Claude Sonnet, else a model that uses tools and sees images. */
export function pickDefaultModel(models: ModelLike[]): string | null {
  const usable = models.filter((m) => m.enabled !== false && m.supportsTools)
  const sonnets = usable
    .filter((m) => /^anthropic\/claude-(?:\d+(?:\.\d+)?-)?sonnet/.test(m.modelId) && !m.modelId.includes(':'))
    .sort((a, b) => compareVersions(versionKey(b.modelId), versionKey(a.modelId)))
  return sonnets[0]?.modelId ?? usable.find((m) => m.supportsVision)?.modelId ?? usable[0]?.modelId ?? null
}

type ProgressKey = 'download' | 'install' | 'save' | 'create' | 'boot' | 'desktop'
type ProgressState = 'done' | 'active' | 'pending' | 'error'

export interface SetupVmProgress {
  items: Array<{ key: ProgressKey; state: ProgressState }>
  percent: number
  etaSeconds: number | null
  failed: 'golden' | 'vm' | null
  /** The golden image exists but is older than this app's: its newer version is being prepared. */
  updatingSystem: boolean
}

/** The golden image must be built before the setup creates the VM: missing, or older than this app's. */
export function goldenNeedsBuild(golden: GoldenStatus | null): boolean {
  return golden !== null && (golden.state !== 'ready' || golden.outdated)
}

/** A build that ended without the image this app needs (an outdated image stays `ready`, with the error). */
function goldenBuildFailed(golden: GoldenStatus): boolean {
  return golden.state === 'failed' || (golden.state === 'ready' && golden.outdated && golden.error !== null)
}

/** The setup created (or is creating) the VM, even on an outdated image ("Use the current version"). */
function vmUnderway(vm: VmInfo | null): boolean {
  if (!vm || vm.state === 'not_created') return false
  return !(vm.state === 'error' && vm.errorCode === 'GOLDEN_NOT_FOUND')
}

/** Typical seconds from `create` to a running VM with the first bot's desktop. */
export const VM_CREATE_SECONDS = 50
const BOOT_SECONDS = 40

function vmItems(vm: VmInfo | null): Array<{ key: ProgressKey; state: ProgressState }> {
  const order: ProgressKey[] = ['create', 'boot', 'desktop']
  if (vm?.state === 'running') return order.map((key) => ({ key, state: 'done' }))
  const phase = vm?.state === 'starting' ? (vm.phase ?? 'creating') : null
  const activeIndex = phase === 'creating' ? 0 : phase === 'booting' ? 1 : phase === 'provisioning' ? 2 : -1
  const failed = vm?.state === 'error'
  return order.map((key, i) => ({
    key,
    state:
      activeIndex < 0
        ? failed && i === 0
          ? 'error'
          : 'pending'
        : i < activeIndex
          ? 'done'
          : i === activeIndex
            ? 'active'
            : 'pending',
  }))
}

/**
 * The golden image build (when it is missing or outdated) followed by the workspace VM.
 * `bootingFor` is how long the VM has been starting, for the bar between phases.
 */
export function setupVmProgress(input: {
  golden: GoldenStatus | null
  vm: VmInfo | null
  bootingForSeconds: number
}): SetupVmProgress {
  const { golden, vm } = input
  const buildingGolden = goldenNeedsBuild(golden) && !vmUnderway(vm)
  const vmRunning = vm?.state === 'running'
  const vmFailed = vm?.state === 'error' && vm.errorCode !== 'GOLDEN_NOT_FOUND'
  const elapsed = Math.max(0, input.bootingForSeconds)
  const phase = vm?.state === 'starting' ? (vm.phase ?? 'creating') : null
  const vmFraction = vmRunning
    ? 1
    : phase === 'creating'
      ? 0.05
      : phase === 'booting'
        ? 0.1 + 0.7 * Math.min(1, elapsed / BOOT_SECONDS)
        : phase === 'provisioning'
          ? 0.88
          : 0
  const vmEta = vmRunning ? 0 : Math.max(5, VM_CREATE_SECONDS - Math.round(elapsed))

  if (buildingGolden && golden) {
    const stage = golden.stage
    const stages: ProgressKey[] = ['download', 'install', 'save']
    const building = golden.state === 'building'
    const failed = !building && goldenBuildFailed(golden)
    const current = building ? (stage ? stages.indexOf(stage) : 0) : -1
    const items = stages.map((key, i) => ({
      key,
      state: (failed
        ? i === Math.max(0, current)
          ? 'error'
          : 'pending'
        : i < current
          ? 'done'
          : i === current
            ? 'active'
            : 'pending') as ProgressState,
    }))
    return {
      items: [...items, { key: 'desktop', state: 'pending' }],
      percent: building ? Math.round(golden.percent * 0.85) : 0,
      etaSeconds: building && golden.etaSeconds !== null ? golden.etaSeconds + VM_CREATE_SECONDS : null,
      failed: failed ? 'golden' : null,
      updatingSystem: golden.revision !== null,
    }
  }

  const items = vmItems(vm)
  return {
    items,
    percent: Math.round(vmFraction * 100),
    etaSeconds: vmFailed ? null : vmEta,
    failed: vmFailed ? 'vm' : null,
    updatingSystem: false,
  }
}

/** "~6 min" on the create button: the golden build takes most of it (a rebuild reuses the download). */
/** "~3 min left" or "less than 1 min". */
export function etaText(etaSeconds: number, t: TFunction): string {
  return etaSeconds < 60
    ? t('setup.machine.etaSoon')
    : t('setup.machine.eta', { minutes: Math.round(etaSeconds / 60) })
}

export function createMachineMinutes(golden: GoldenStatus | null): number {
  if (!golden || !goldenNeedsBuild(golden)) return 1
  return golden.revision === null ? 6 : 4
}

/** The setup may create the VM now: the golden image is current (or the user took the outdated one). */
export function goldenReadyForSetup(golden: GoldenStatus | null): boolean {
  return golden !== null && !goldenNeedsBuild(golden)
}

/** A setup whose build is neither running nor failed (e.g. the build died with the daemon) starts it again. */
export function goldenBuildStalled(golden: GoldenStatus | null, vm: VmInfo | null): boolean {
  return (
    golden !== null &&
    goldenNeedsBuild(golden) &&
    golden.state !== 'building' &&
    !goldenBuildFailed(golden) &&
    !vmUnderway(vm)
  )
}

export interface LoginPollerOptions {
  check: () => Promise<CliLoginStatus>
  onLoggedIn: () => void
  /** Every answer that is not a login yet. */
  onStatus?: (status: CliLoginStatus) => void
  intervalMs?: number
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (timer: unknown) => void
}

/** Asks the CLI's login status every few seconds until it reports a login; errors just wait for the next round. */
export function createLoginPoller(options: LoginPollerOptions): { start(): void; stop(): void } {
  const setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
  const clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>))
  const interval = options.intervalMs ?? 3000
  let timer: unknown = null
  let stopped = true

  const round = async () => {
    timer = null
    let status: CliLoginStatus | null
    try {
      status = await options.check()
    } catch {
      status = null
    }
    if (stopped) return
    if (status?.loggedIn) {
      stopped = true
      options.onLoggedIn()
      return
    }
    if (status) options.onStatus?.(status)
    timer = setTimer(() => void round(), interval)
  }

  return {
    start() {
      if (!stopped) return
      stopped = false
      void round()
    },
    stop() {
      stopped = true
      if (timer !== null) clearTimer(timer)
      timer = null
    },
  }
}

export interface LoginTerminalKeeperOptions {
  reopen: () => Promise<unknown>
  /** Automatic reopens before it is left to the "reopen" button. */
  maxReopens?: number
  /** How long the terminal must be seen closed before reopening it. */
  debounceMs?: number
  now?: () => number
}

/**
 * Keeps the login terminal on screen while the login is pending: when the user closes it (and is still not
 * logged in), it comes back after a short wait, a few times at most. Fed with each login status.
 */
export function createLoginTerminalKeeper(options: LoginTerminalKeeperOptions) {
  const now = options.now ?? Date.now
  const maxReopens = options.maxReopens ?? 3
  const debounceMs = options.debounceMs ?? 2500
  let closedSince: number | null = null
  let reopens = 0
  let reopening = false

  return {
    observe(status: CliLoginStatus): void {
      if (status.loggedIn !== false || status.terminalOpen !== false) {
        closedSince = null
        return
      }
      if (reopening) return
      const at = now()
      if (closedSince === null) {
        closedSince = at
        return
      }
      if (at - closedSince < debounceMs || reopens >= maxReopens) return
      reopens += 1
      reopening = true
      closedSince = null
      void options
        .reopen()
        .catch(() => undefined)
        .finally(() => {
          reopening = false
        })
    },
    /** The user reopened it: the automatic reopens start over. */
    reset(): void {
      reopens = 0
      closedSince = null
    },
    get exhausted(): boolean {
      return reopens >= maxReopens
    },
  }
}

export type WhpxCase = 'feature_disabled' | 'reboot_pending' | 'virtualization_disabled' | 'unavailable'

/**
 * Why WHPX is off (`vmAccel.reason` from `GET /host`), or null when it is on or this is not Windows.
 * Reasons the app does not know yet that start with `whpx_` are handled like `whpx_unavailable`.
 */
export function whpxCase(host: HostInfo | null): WhpxCase | null {
  const accel = host?.vmAccel
  if (host?.platform?.os !== 'win32' || !accel || accel.kind === 'whpx' || !accel.reason) return null
  switch (accel.reason) {
    case 'whpx_feature_disabled':
      return 'feature_disabled'
    case 'whpx_reboot_pending':
      return 'reboot_pending'
    case 'virtualization_disabled':
      return 'virtualization_disabled'
    default:
      return accel.reason.startsWith('whpx_') ? 'unavailable' : null
  }
}

export const STARTER_SUGGESTIONS = ['finances', 'repos', 'research', 'news'] as const
export type StarterSuggestion = (typeof STARTER_SUGGESTIONS)[number]
