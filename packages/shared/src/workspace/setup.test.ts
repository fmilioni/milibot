import { describe, expect, it } from 'vitest'

import {
  clampVmSize,
  defaultPreset,
  isSetupTransitionAllowed,
  matchPreset,
  nextSetupStep,
  presetFits,
  VM_PRESETS,
} from './setup'

describe('setup steps', () => {
  it('goes providers → vm → login (only with a Claude subscription) → done', () => {
    expect(nextSetupStep('providers', { needsLogin: true })).toBe('vm')
    expect(nextSetupStep('vm', { needsLogin: true })).toBe('login')
    expect(nextSetupStep('vm', { needsLogin: false })).toBe('done')
    expect(nextSetupStep('login', { needsLogin: true })).toBe('done')
    expect(nextSetupStep('done', { needsLogin: true })).toBe('done')
  })

  it('only moves forward, one screen at a time', () => {
    expect(isSetupTransitionAllowed('providers', 'vm')).toBe(true)
    expect(isSetupTransitionAllowed('providers', 'login')).toBe(false)
    expect(isSetupTransitionAllowed('providers', 'done')).toBe(false)
    expect(isSetupTransitionAllowed('vm', 'done')).toBe(true)
    expect(isSetupTransitionAllowed('login', 'vm')).toBe(false)
    expect(isSetupTransitionAllowed('login', 'providers')).toBe(true)
    expect(isSetupTransitionAllowed('done', 'providers')).toBe(false)
    expect(isSetupTransitionAllowed('login', 'login')).toBe(true)
  })
})

describe('VM presets', () => {
  const big = { maxVmCpus: 16, maxVmMemoryGb: 28 }
  const small = { maxVmCpus: 6, maxVmMemoryGb: 8 }
  const tiny = { maxVmCpus: 2, maxVmMemoryGb: 4 }

  it('are Leve 2/4/40, Recomendado 4/8/60 and Potente 8/16/80', () => {
    expect(VM_PRESETS.map((p) => [p.id, p.cpus, p.memGb, p.dataGb])).toEqual([
      ['light', 2, 4, 40],
      ['recommended', 4, 8, 60],
      ['powerful', 8, 16, 80],
    ])
  })

  it('fit the host limits', () => {
    const powerful = VM_PRESETS[2]!
    expect(presetFits(powerful, big)).toBe(true)
    expect(presetFits(powerful, small)).toBe(false)
    expect(defaultPreset(big)).toBe('recommended')
    expect(defaultPreset(small)).toBe('recommended')
    expect(defaultPreset(tiny)).toBe('light')
    expect(defaultPreset({ maxVmCpus: 1, maxVmMemoryGb: 2 })).toBeNull()
  })

  it('recognizes a preset and clamps a custom size', () => {
    expect(matchPreset({ cpus: 4, memGb: 8, dataGb: 60 })).toBe('recommended')
    expect(matchPreset({ cpus: 4, memGb: 8, dataGb: 70 })).toBeNull()
    expect(clampVmSize({ cpus: 40, memGb: 64, dataGb: 1000 }, big)).toEqual({
      cpus: 16,
      memGb: 28,
      dataGb: 500,
    })
    expect(clampVmSize({ cpus: 0, memGb: 1, dataGb: 5 }, big)).toEqual({ cpus: 1, memGb: 2, dataGb: 20 })
    expect(clampVmSize({ cpus: 3, memGb: 6, dataGb: 64 }, big)).toEqual({ cpus: 3, memGb: 6, dataGb: 60 })
  })
})
