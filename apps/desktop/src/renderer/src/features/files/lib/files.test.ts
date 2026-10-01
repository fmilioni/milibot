import { describe, expect, it } from 'vitest'

import { fileGroup, groupFiles, monthLabel, vmFolder } from './files'

const now = new Date(2026, 8, 29, 15, 0).getTime()
const at = (month: number, day: number, hour = 10) => new Date(2026, month, day, hour).getTime()

describe('files list', () => {
  it('buckets files by day, then by month', () => {
    expect(fileGroup(at(8, 29, 1), now)).toBe('today')
    expect(fileGroup(at(8, 28, 23), now)).toBe('yesterday')
    expect(fileGroup(at(8, 23), now)).toBe('week')
    expect(fileGroup(at(8, 22), now)).toBe('month:2026-9')
    expect(fileGroup(at(7, 30), now)).toBe('month:2026-8')
  })

  it('groups consecutive files of the same bucket', () => {
    const files = [at(8, 29), at(8, 29, 8), at(8, 28), at(7, 2)].map((createdAt) => ({ createdAt }))
    expect(groupFiles(files, now).map((g) => [g.key, g.items.length])).toEqual([
      ['today', 2],
      ['yesterday', 1],
      ['month:2026-8', 1],
    ])
  })

  it('names months and VM folders', () => {
    expect(monthLabel('month:2026-8', 'pt-BR')).toBe('agosto de 2026')
    expect(monthLabel('today', 'pt-BR')).toBeNull()
    expect(vmFolder('/workspace/uploads/nina/2026-09-29/a.zip')).toBe('/workspace/uploads/nina/2026-09-29')
  })
})
