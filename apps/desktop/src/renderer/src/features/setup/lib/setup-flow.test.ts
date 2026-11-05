import type { GoldenStatus, HostInfo, Provider, VmInfo } from '@milibot/shared'
import { describe, expect, it } from 'vitest'

import type { ProviderStepState } from './setup'
import {
  initialVmSize,
  loginEngines,
  planProviderSave,
  setupComputerKind,
  suggestedComputer,
  vmStepAdvance,
  vmStepNeedsBuild,
  vmStepNeedsStart,
} from './setup-flow'

const provider = (id: string, patch: Partial<Provider>): Provider =>
  ({ id, type: 'openai_compatible', preset: null, baseUrl: null, authMode: null, ...patch }) as Provider

const claude = provider('p_claude', { type: 'claude_code', authMode: 'subscription' })
const codexKey = provider('p_codex', { type: 'codex', authMode: 'api_key' })
const openRouter = provider('p_or', { preset: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1' })
const compatible = provider('p_local', { baseUrl: 'http://localhost:1234/v1' })

const state = (patch: Partial<ProviderStepState>): ProviderStepState => ({
  checked: { claude_code: false, codex: false, antigravity: false, openrouter: false, compatible: false },
  openRouterKey: '',
  openRouterCheck: { status: 'empty' },
  compatibleIds: [],
  defaultRow: null,
  ...patch,
})

const golden = (patch: Partial<GoldenStatus>): GoldenStatus => ({
  state: 'ready',
  stage: null,
  percent: 100,
  downloadBytes: null,
  etaSeconds: null,
  startedAt: 1,
  error: null,
  revision: 2,
  latestRevision: 2,
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

const host = (maxVmCpus: number, maxVmMemoryGb: number) => ({ maxVmCpus, maxVmMemoryGb }) as HostInfo

describe('planProviderSave', () => {
  it('creates the checked CLI engines and makes the chosen row the default', () => {
    const plan = planProviderSave(
      state({
        checked: { claude_code: true, codex: true, antigravity: false, openrouter: false, compatible: false },
        defaultRow: 'codex',
      }),
      [],
    )
    expect(plan.ops).toEqual([
      { op: 'createCli', engine: 'claude_code' },
      { op: 'createCli', engine: 'codex' },
    ])
    expect(plan.defaultRow).toBe('codex')
  })

  it('keeps what is there, removes the unchecked rows, in row order', () => {
    const plan = planProviderSave(
      state({
        checked: {
          claude_code: true,
          codex: false,
          antigravity: false,
          openrouter: false,
          compatible: false,
        },
      }),
      [claude, codexKey, openRouter, compatible],
    )
    expect(plan.ops).toEqual([
      { op: 'remove', providerId: 'p_codex' },
      { op: 'remove', providerId: 'p_or' },
      { op: 'remove', providerId: 'p_local' },
    ])
    expect(plan.ids).toEqual({ claude_code: 'p_claude' })
    expect(plan.defaultRow).toBe('claude_code')
  })

  it('creates OpenRouter with the key, or stores a new key on the one there', () => {
    const checked = {
      claude_code: false,
      codex: false,
      antigravity: false,
      openrouter: true,
      compatible: true,
    }
    const fresh = planProviderSave(
      state({ checked, openRouterKey: ' sk-or-1 ', compatibleIds: ['p_local'], defaultRow: 'compatible' }),
      [compatible],
    )
    expect(fresh.ops).toEqual([{ op: 'openRouter', existing: null, apiKey: 'sk-or-1' }])
    expect(fresh.ids).toEqual({ compatible: 'p_local' })
    expect(fresh.defaultRow).toBe('compatible')
    const kept = planProviderSave(state({ checked, compatibleIds: ['p_local'] }), [openRouter, compatible])
    expect(kept.ops).toEqual([{ op: 'openRouter', existing: openRouter, apiKey: null }])
  })
})

describe('loginEngines', () => {
  it('lists the engines on a subscription, Claude Code first', () => {
    const codexSub = provider('p_cs', { type: 'codex', authMode: null })
    expect(loginEngines([codexSub, claude])).toEqual(['claude_code', 'codex'])
    expect(loginEngines([codexKey, openRouter])).toEqual([])
    expect(loginEngines(null)).toEqual([])
  })
})

describe('initialVmSize', () => {
  it('waits for the host and a moment for the VM config', () => {
    expect(initialVmSize(null, vm({}), true)).toBeNull()
    expect(initialVmSize(host(16, 32), null, false)).toBeNull()
  })

  it("takes the host's preset, or a size copied from another workspace that fits", () => {
    expect(initialVmSize(host(16, 32), null, true)).toEqual({ cpus: 4, memGb: 8, dataGb: 60 })
    expect(initialVmSize(host(2, 4), null, true)).toEqual({ cpus: 2, memGb: 4, dataGb: 40 })
    const copied = vm({ config: { cpus: 8, memGb: 16, dataGb: 80, systemGb: 40 } })
    expect(initialVmSize(host(16, 32), copied, false)).toEqual({ cpus: 8, memGb: 16, dataGb: 80 })
    expect(initialVmSize(host(4, 8), copied, false)).toEqual({ cpus: 4, memGb: 8, dataGb: 60 })
  })
})

describe('suggestedComputer', () => {
  const able = {
    maxVmCpus: 16,
    maxVmMemoryGb: 28,
    qemu: { found: true, path: '/q' },
    vmAccel: { kind: 'hvf', slow: false },
  } as HostInfo

  it('waits for the host', () => {
    expect(suggestedComputer(null)).toBeNull()
  })

  it('takes a VM on a host that runs one well', () => {
    expect(suggestedComputer(able)).toEqual({ kind: 'vm' })
  })

  it.each([
    ['qemu', { ...able, qemu: { found: false, path: null } }],
    ['slow', { ...able, vmAccel: { kind: 'tcg', slow: true } }],
    ['memory', { ...able, maxVmMemoryGb: 3 }],
  ] as const)('starts without a computer when the reason is %s', (reason, hostInfo) => {
    expect(suggestedComputer(hostInfo as HostInfo)).toEqual({ kind: 'none', reason })
  })
})

describe('setupComputerKind', () => {
  const base = { step: 'providers' as const, stored: 'vm' as const, chosen: null, vm: null, suggested: null }

  it('keeps the stored computer once step 1 was saved', () => {
    expect(setupComputerKind({ ...base, step: 'vm', stored: 'none', chosen: 'vm' })).toBe('none')
  })

  it("takes the user's pick, else a VM already running, else the host's suggestion", () => {
    expect(setupComputerKind({ ...base, chosen: 'none', vm: vm({ state: 'running' }) })).toBe('none')
    expect(setupComputerKind({ ...base, vm: vm({ state: 'running' }), suggested: 'none' })).toBe('vm')
    expect(setupComputerKind({ ...base, suggested: 'none' })).toBe('none')
    expect(setupComputerKind(base)).toBe('vm')
  })
})

describe('step 2 kicks', () => {
  const input = {
    step: 'vm' as const,
    computer: 'vm' as const,
    vm: vm({}),
    golden: golden({}),
    providers: [claude],
  }

  it('moves on once the VM runs and the providers are known', () => {
    expect(vmStepAdvance({ ...input, vm: vm({ state: 'running' }) })).toBe('login')
    expect(vmStepAdvance({ ...input, vm: vm({ state: 'running' }), providers: [codexKey] })).toBe('done')
    expect(vmStepAdvance({ ...input, vm: vm({ state: 'running' }), providers: null })).toBeNull()
    expect(vmStepAdvance({ ...input, vm: vm({ state: 'starting' }) })).toBeNull()
    expect(vmStepAdvance({ ...input, step: 'providers', vm: vm({ state: 'running' }) })).toBeNull()
  })

  it('moves on right away without a computer, and never touches the VM', () => {
    const none = { ...input, computer: 'none' as const, providers: [openRouter] }

    expect(vmStepAdvance(none)).toBe('done')
    expect(vmStepNeedsStart(none)).toBe(false)
    expect(vmStepNeedsBuild({ ...none, golden: golden({ revision: 1, outdated: true }) })).toBe(false)
  })

  it('starts a VM left idle with the image ready', () => {
    expect(vmStepNeedsStart(input)).toBe(true)
    expect(vmStepNeedsStart({ ...input, vm: vm({ state: 'stopped' }) })).toBe(true)
    expect(vmStepNeedsStart({ ...input, vm: vm({ state: 'error', errorCode: 'GOLDEN_NOT_FOUND' }) })).toBe(
      true,
    )
    expect(vmStepNeedsStart({ ...input, vm: vm({ state: 'starting' }) })).toBe(false)
    expect(vmStepNeedsStart({ ...input, golden: golden({ revision: 1, outdated: true }) })).toBe(false)
    expect(vmStepNeedsStart({ ...input, vm: null })).toBe(false)
  })

  it('builds an image nothing is building', () => {
    const outdated = golden({ revision: 1, outdated: true })
    expect(vmStepNeedsBuild({ ...input, golden: outdated })).toBe(true)
    expect(vmStepNeedsBuild({ ...input, golden: golden({ ...outdated, state: 'building' }) })).toBe(false)
    expect(vmStepNeedsBuild({ ...input, step: 'login', golden: outdated })).toBe(false)
  })
})
