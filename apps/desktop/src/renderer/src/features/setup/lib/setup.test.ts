import type { CliLoginStatus, GoldenStatus, HostInfo, Provider, VmInfo } from '@milibot/shared'
import type { TFunction } from 'i18next'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  createLoginPoller,
  createLoginTerminalKeeper,
  createMachineMinutes,
  effectiveDefault,
  etaText,
  goldenBuildStalled,
  goldenNeedsBuild,
  goldenReadyForSetup,
  initialProviderStep,
  looksLikeOpenRouterKey,
  maskKey,
  pickDefaultModel,
  PROVIDER_ROWS,
  providerRowName,
  providerStepIssues,
  type ProviderStepState,
  setupVmProgress,
  VM_CREATE_SECONDS,
  whpxCase,
} from './setup'

function provider(patch: Partial<Provider>): Provider {
  return {
    id: 'provider_1',
    type: 'openai_compatible',
    name: 'X',
    preset: null,
    baseUrl: null,
    extraHeaders: {},
    lightModel: null,
    isDefault: false,
    defaultModel: null,
    hasSecret: false,
    authMode: null,
    idleTimeoutMinutes: null,
    reasoningParam: null,
    outputCapField: null,
    reasoningReplay: null,
    createdAt: 1,
    updatedAt: 1,
    ...patch,
  }
}

const base: ProviderStepState = {
  checked: { claude_code: false, codex: false, antigravity: false, openrouter: false, compatible: false },
  openRouterKey: '',
  openRouterCheck: { status: 'empty' },
  compatibleIds: [],
  defaultRow: null,
}

describe('provider step', () => {
  it('lists a row per CLI engine, named by its brand, before the API rows', () => {
    const t = ((key: string) => `t:${key}`) as unknown as TFunction
    expect(PROVIDER_ROWS).toEqual(['claude_code', 'codex', 'antigravity', 'openrouter', 'compatible'])
    expect(PROVIDER_ROWS.map((row) => providerRowName(t, row))).toEqual([
      'Claude Code',
      'Codex',
      'Antigravity',
      't:setup.providers.openRouter.name',
      't:setup.providers.compatible.name',
    ])
  })

  it('starts with Claude Code on a fresh workspace and mirrors copied providers', () => {
    const fresh = initialProviderStep([])
    expect(fresh.checked).toEqual({
      claude_code: true,
      codex: false,
      antigravity: false,
      openrouter: false,
      compatible: false,
    })
    expect(fresh.defaultRow).toBe('claude_code')
    const copied = initialProviderStep([
      provider({ id: 'a', type: 'claude_code' }),
      provider({ id: 'b', preset: 'openrouter', hasSecret: true, isDefault: true }),
      provider({ id: 'c', baseUrl: 'http://10.0.0.2:1234/v1' }),
      provider({ id: 'd', type: 'codex' }),
    ])
    expect(copied.checked).toEqual({
      claude_code: true,
      codex: true,
      antigravity: false,
      openrouter: true,
      compatible: true,
    })
    expect(copied.openRouterCheck).toEqual({ status: 'saved' })
    expect(copied.compatibleIds).toEqual(['c'])
    expect(copied.defaultRow).toBe('openrouter')
  })

  it('needs at least one provider, a working OpenRouter key and a configured compatible server', () => {
    expect(providerStepIssues(base)).toEqual(['none_selected'])
    expect(providerStepIssues({ ...base, checked: { ...base.checked, claude_code: true } })).toEqual([])
    const openRouter = { ...base, checked: { ...base.checked, openrouter: true } }
    expect(providerStepIssues(openRouter)).toEqual(['openrouter_key'])
    expect(providerStepIssues({ ...openRouter, openRouterCheck: { status: 'checking' } })).toEqual([
      'openrouter_key',
    ])
    expect(providerStepIssues({ ...openRouter, openRouterCheck: { status: 'invalid' } })).toEqual([
      'openrouter_key',
    ])
    expect(providerStepIssues({ ...openRouter, openRouterCheck: { status: 'valid', creditUsd: 3 } })).toEqual(
      [],
    )
    expect(providerStepIssues({ ...base, checked: { ...base.checked, compatible: true } })).toEqual([
      'compatible_missing',
    ])
  })

  it('falls back to the first checked provider as the default', () => {
    const state = {
      ...base,
      checked: { claude_code: false, codex: false, antigravity: false, openrouter: true, compatible: true },
    }
    expect(effectiveDefault({ ...state, defaultRow: 'claude_code' })).toBe('openrouter')
    expect(effectiveDefault({ ...state, defaultRow: 'compatible' })).toBe('compatible')
    expect(effectiveDefault(base)).toBeNull()
  })

  it('recognizes and masks OpenRouter keys', () => {
    expect(looksLikeOpenRouterKey('sk-or-v1-0123456789abcdef')).toBe(true)
    expect(looksLikeOpenRouterKey('sk-ant-123')).toBe(false)
    expect(maskKey('sk-or-v1-0123456789ab3f9a')).toBe('sk-or-••••3f9a')
  })

  it('picks the newest Claude Sonnet for OpenRouter, else a model with tools and vision', () => {
    const m = (modelId: string, tools = true, vision = true) => ({
      modelId,
      supportsTools: tools,
      supportsVision: vision,
    })
    expect(
      pickDefaultModel([
        m('openai/gpt-5'),
        m('anthropic/claude-sonnet-4'),
        m('anthropic/claude-sonnet-4.5'),
        m('anthropic/claude-3.7-sonnet'),
        m('anthropic/claude-sonnet-4.5:beta'),
        m('anthropic/claude-opus-4.1'),
      ]),
    ).toBe('anthropic/claude-sonnet-4.5')
    expect(pickDefaultModel([m('meta/llama', true, false), m('google/gemini', true, true)])).toBe(
      'google/gemini',
    )
    expect(pickDefaultModel([m('x/no-tools', false)])).toBeNull()
  })
})

describe('machine progress', () => {
  const golden = (patch: Partial<GoldenStatus>): GoldenStatus => ({
    state: 'building',
    stage: 'install',
    percent: 60,
    downloadBytes: null,
    etaSeconds: 90,
    startedAt: 1,
    error: null,
    revision: null,
    latestRevision: 1,
    outdated: false,
    ...patch,
  })
  const vm = (patch: Partial<VmInfo>): VmInfo => ({
    state: 'not_created',
    config: { cpus: 4, memGb: 8, dataGb: 60, systemGb: 40 },
    portBase: 47000,
    desktops: 0,
    ...patch,
  })

  it('shows the golden build stages before the first bot desktop', () => {
    const progress = setupVmProgress({ golden: golden({}), vm: vm({}), bootingForSeconds: 0 })
    expect(progress.items.map((i) => `${i.key}:${i.state}`)).toEqual([
      'download:done',
      'install:active',
      'save:pending',
      'desktop:pending',
    ])
    expect(progress.percent).toBe(51)
    expect(progress.etaSeconds).toBe(90 + VM_CREATE_SECONDS)
    const failed = setupVmProgress({
      golden: golden({ state: 'failed', stage: null, error: 'x' }),
      vm: vm({}),
      bootingForSeconds: 0,
    })
    expect(failed.failed).toBe('golden')
    expect(failed.items[0]?.state).toBe('error')
  })

  it('follows the VM phases once the image exists', () => {
    const ready = golden({ state: 'ready', stage: null, percent: 100 })
    const booting = setupVmProgress({
      golden: ready,
      vm: vm({ state: 'starting', phase: 'booting' }),
      bootingForSeconds: 20,
    })
    expect(booting.items.map((i) => `${i.key}:${i.state}`)).toEqual([
      'create:done',
      'boot:active',
      'desktop:pending',
    ])
    expect(booting.percent).toBe(45)
    expect(booting.etaSeconds).toBe(VM_CREATE_SECONDS - 20)
    const running = setupVmProgress({ golden: ready, vm: vm({ state: 'running' }), bootingForSeconds: 60 })
    expect(running.percent).toBe(100)
    expect(running.items.every((i) => i.state === 'done')).toBe(true)
    const failed = setupVmProgress({
      golden: ready,
      vm: vm({ state: 'error', errorCode: 'BOOT_TIMEOUT' }),
      bootingForSeconds: 0,
    })
    expect(failed.failed).toBe('vm')
  })

  it('prepares the newest system first when the golden image is outdated', () => {
    const outdated = { revision: 1, latestRevision: 2, outdated: true }
    const building = setupVmProgress({ golden: golden(outdated), vm: vm({}), bootingForSeconds: 0 })
    expect(building.updatingSystem).toBe(true)
    expect(building.items.map((i) => i.key)).toEqual(['download', 'install', 'save', 'desktop'])
    expect(building.failed).toBeNull()

    // A failed rebuild leaves the old image `ready`, with the error.
    const failedGolden = golden({ ...outdated, state: 'ready', stage: null, percent: 100, error: 'rc=1' })
    const failed = setupVmProgress({ golden: failedGolden, vm: vm({}), bootingForSeconds: 0 })
    expect(failed).toMatchObject({ failed: 'golden', updatingSystem: true, percent: 0, etaSeconds: null })
    expect(goldenBuildStalled(failedGolden, vm({}))).toBe(false)

    // "Use the current version": the VM is created on the old image and the VM phases take over.
    const usingCurrent = setupVmProgress({
      golden: failedGolden,
      vm: vm({ state: 'starting', phase: 'creating' }),
      bootingForSeconds: 0,
    })
    expect(usingCurrent).toMatchObject({ failed: null, updatingSystem: false })
    expect(usingCurrent.items.map((i) => `${i.key}:${i.state}`)).toEqual([
      'create:active',
      'boot:pending',
      'desktop:pending',
    ])
  })

  it('tells when the setup may create the VM and when the build must start again', () => {
    const current = golden({ state: 'ready', stage: null, revision: 2, latestRevision: 2 })
    const outdated = golden({ state: 'ready', stage: null, revision: 1, latestRevision: 2, outdated: true })
    const missing = golden({ state: 'missing', stage: null, percent: 0 })
    expect(goldenReadyForSetup(current)).toBe(true)
    expect(goldenReadyForSetup(outdated)).toBe(false)
    expect(goldenReadyForSetup(null)).toBe(false)
    expect(goldenNeedsBuild(outdated)).toBe(true)
    expect(goldenBuildStalled(outdated, vm({}))).toBe(true)
    expect(goldenBuildStalled(missing, vm({ state: 'error', errorCode: 'GOLDEN_NOT_FOUND' }))).toBe(true)
    expect(goldenBuildStalled(golden({ ...outdated, state: 'building' }), vm({}))).toBe(false)
    expect(goldenBuildStalled(outdated, vm({ state: 'running' }))).toBe(false)
    expect(goldenBuildStalled(current, vm({}))).toBe(false)

    expect(createMachineMinutes(missing)).toBe(6)
    expect(createMachineMinutes(outdated)).toBe(4)
    expect(createMachineMinutes(current)).toBe(1)
    expect(createMachineMinutes(null)).toBe(1)
  })
})

function status(patch: Partial<CliLoginStatus>): CliLoginStatus {
  return { loggedIn: false, terminalOpen: true, loggedInElsewhere: false, ...patch }
}

describe('login poller', () => {
  afterEach(() => vi.useRealTimers())

  it('polls until Claude reports a login, surviving errors', async () => {
    vi.useFakeTimers()
    const answers: Array<boolean | null | Error> = [null, false, new Error('boom'), true]
    const check = vi.fn(async () => {
      const next = answers.shift()
      if (next instanceof Error) throw next
      return status({ loggedIn: next ?? null })
    })
    const onLoggedIn = vi.fn()
    const onStatus = vi.fn()
    const poller = createLoginPoller({ check, onLoggedIn, onStatus, intervalMs: 1000 })
    poller.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(check).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(3000)
    expect(check).toHaveBeenCalledTimes(4)
    expect(onLoggedIn).toHaveBeenCalledTimes(1)
    expect(onStatus.mock.calls.map(([s]) => s.loggedIn)).toEqual([null, false])
    await vi.advanceTimersByTimeAsync(5000)
    expect(check).toHaveBeenCalledTimes(4)
  })

  it('stops polling when stopped', async () => {
    vi.useFakeTimers()
    const check = vi.fn(async () => status({ loggedIn: false }))
    const poller = createLoginPoller({ check, onLoggedIn: () => {}, intervalMs: 1000 })
    poller.start()
    await vi.advanceTimersByTimeAsync(1500)
    poller.stop()
    const calls = check.mock.calls.length
    await vi.advanceTimersByTimeAsync(5000)
    expect(check).toHaveBeenCalledTimes(calls)
  })
})

describe('login terminal keeper', () => {
  it('reopens a terminal the user closed before logging in, after a short wait and a few times at most', async () => {
    let clock = 0
    const reopen = vi.fn(async () => undefined)
    const keeper = createLoginTerminalKeeper({ reopen, maxReopens: 2, debounceMs: 2500, now: () => clock })
    const tick = async (s: CliLoginStatus, ms = 3000) => {
      keeper.observe(s)
      await Promise.resolve()
      clock += ms
    }

    await tick(status({ terminalOpen: true }))
    await tick(status({ terminalOpen: false }), 1000)
    await tick(status({ terminalOpen: false }))
    expect(reopen).not.toHaveBeenCalled()
    await tick(status({ terminalOpen: false }))
    expect(reopen).toHaveBeenCalledTimes(1)

    await tick(status({ terminalOpen: true }))
    await tick(status({ terminalOpen: false }))
    await tick(status({ terminalOpen: false }))
    expect(reopen).toHaveBeenCalledTimes(2)
    expect(keeper.exhausted).toBe(true)

    await tick(status({ terminalOpen: false }))
    await tick(status({ terminalOpen: false }))
    expect(reopen).toHaveBeenCalledTimes(2)

    keeper.reset()
    expect(keeper.exhausted).toBe(false)
    await tick(status({ terminalOpen: false }))
    await tick(status({ terminalOpen: false }))
    expect(reopen).toHaveBeenCalledTimes(3)
  })

  it('leaves the terminal alone once logged in or when its state is unknown', async () => {
    let clock = 0
    const reopen = vi.fn(async () => undefined)
    const keeper = createLoginTerminalKeeper({ reopen, now: () => clock })
    for (const s of [
      status({ loggedIn: true, terminalOpen: false }),
      status({ loggedIn: null, terminalOpen: false }),
      status({ terminalOpen: null }),
    ]) {
      for (let i = 0; i < 3; i++) {
        keeper.observe(s)
        clock += 5000
      }
    }
    expect(reopen).not.toHaveBeenCalled()
  })

  it('never stacks reopens while one is still on its way', async () => {
    let clock = 0
    let finish: () => void = () => {}
    const reopen = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)))
    const keeper = createLoginTerminalKeeper({ reopen, now: () => clock })
    for (let i = 0; i < 5; i++) {
      keeper.observe(status({ terminalOpen: false }))
      clock += 5000
    }
    expect(reopen).toHaveBeenCalledTimes(1)
    finish()
  })
})

describe('etaText', () => {
  const t = ((key: string, options?: { minutes?: number }) =>
    options ? `${key}:${options.minutes}` : key) as unknown as TFunction
  it('rounds to minutes and says "soon" under a minute', () => {
    expect(etaText(30, t)).toBe('setup.machine.etaSoon')
    expect(etaText(150, t)).toBe('setup.machine.eta:3')
  })
})

describe('whpxCase', () => {
  const host = (os: string, kind: 'whpx' | 'tcg', reason: string | null): HostInfo => ({
    cpus: 8,
    memoryGb: 16,
    maxVmCpus: 6,
    maxVmMemoryGb: 8,
    goldenImage: null,
    qemu: { found: true, path: null },
    platform: { os, arch: 'x64' },
    vmAccel: { kind, preferred: 'whpx', slow: kind === 'tcg', reason },
  })

  it('maps the known reasons', () => {
    expect(whpxCase(host('win32', 'tcg', 'whpx_feature_disabled'))).toBe('feature_disabled')
    expect(whpxCase(host('win32', 'tcg', 'whpx_reboot_pending'))).toBe('reboot_pending')
    expect(whpxCase(host('win32', 'tcg', 'virtualization_disabled'))).toBe('virtualization_disabled')
    expect(whpxCase(host('win32', 'tcg', 'whpx_unavailable'))).toBe('unavailable')
  })

  it('treats unknown whpx_ reasons as unavailable and ignores other reasons', () => {
    expect(whpxCase(host('win32', 'tcg', 'whpx_something_new'))).toBe('unavailable')
    expect(whpxCase(host('win32', 'tcg', 'kvm_unavailable'))).toBeNull()
  })

  it('is null when WHPX is used, off Windows or without a host', () => {
    expect(whpxCase(host('win32', 'whpx', null))).toBeNull()
    expect(whpxCase(host('linux', 'tcg', 'whpx_feature_disabled'))).toBeNull()
    expect(whpxCase(null)).toBeNull()
  })
})
