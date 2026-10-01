import { describe, expect, it } from 'vitest'

import {
  botSliceName,
  desktopDropIn,
  inBotSlice,
  limitProperties,
  parseLimits,
  setPropertyArgs,
  userSliceName,
} from '../src/limits.ts'

describe('bot slices', () => {
  it('escapes dashes so a bot never nests inside another bot', () => {
    expect(botSliceName('iris')).toBe('milibot-bot-iris.slice')
    expect(botSliceName('code-review')).toBe('milibot-bot-code\\x2dreview.slice')
    expect(userSliceName(1601)).toBe('user-1601.slice')
  })

  it('builds set-property commands that apply or clear the limits', () => {
    expect(setPropertyArgs('milibot-bot-iris.slice', { cpuPercent: 150, memoryMb: 3072 })).toEqual([
      'set-property',
      '--runtime',
      'milibot-bot-iris.slice',
      'CPUQuota=150%',
      'MemoryMax=3072M',
    ])
    expect(limitProperties(null)).toEqual(['CPUQuota=', 'MemoryMax=infinity'])
    expect(limitProperties({ cpuPercent: null, memoryMb: 512 })).toEqual(['CPUQuota=', 'MemoryMax=512M'])
  })

  it('wraps a command in a transient scope of the bot slice', () => {
    const spec = inBotSlice(
      {
        file: '/usr/bin/setpriv',
        args: ['--reuid=1500', '--', '/bin/bash', '-lc', 'claude'],
        env: { A: '1' },
      },
      'code-review',
    )
    expect(spec.file).toBe('/usr/bin/systemd-run')
    expect(spec.args).toEqual([
      '--scope',
      '--quiet',
      '--collect',
      '--slice=milibot-bot-code\\x2dreview.slice',
      '--property=OOMPolicy=continue',
      '--',
      '/usr/bin/setpriv',
      '--reuid=1500',
      '--',
      '/bin/bash',
      '-lc',
      'claude',
    ])
    expect(spec.env).toEqual({ A: '1' })
  })

  it('puts the desktop service in the slice with a drop-in', () => {
    expect(desktopDropIn('code-review')).toEqual({
      dir: '/etc/systemd/system/milibot-desktop@code-review.service.d',
      file: '/etc/systemd/system/milibot-desktop@code-review.service.d/10-milibot-slice.conf',
      content: '[Service]\nSlice=milibot-bot-code\\x2dreview.slice\nOOMPolicy=continue\n',
    })
  })

  it('validates limits', () => {
    expect(parseLimits(null)).toBeNull()
    expect(parseLimits({ cpuPercent: 150, memoryMb: 3072 })).toEqual({ cpuPercent: 150, memoryMb: 3072 })
    expect(() => parseLimits({ cpuPercent: 1.5 })).toThrow(/cpuPercent/)
    expect(() => parseLimits({ memoryMb: 1 })).toThrow(/memoryMb/)
  })
})
