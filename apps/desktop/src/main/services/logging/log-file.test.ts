import { describe, expect, it } from 'vitest'

import { appendRotating, formatLogEntry, type LogFs } from './log-file'

function memoryFs(sizes: Record<string, number>) {
  const calls: string[] = []
  const fs: LogFs = {
    size: (file) => sizes[file] ?? 0,
    rename: (from, to) => calls.push(`rename ${from} ${to}`),
    append: (file, text) => calls.push(`append ${file} ${text.length}`),
  }
  return { fs, calls }
}

describe('log file', () => {
  it('formats an entry with its window and the non-empty details', () => {
    const at = new Date(Date.UTC(2026, 8, 30, 10, 0, 0))
    expect(
      formatLogEntry(at, 'workspace:ws_1', 'render in chat: boom', ['Error: boom\n  at X  ', undefined, ' ']),
    ).toBe('[2026-09-30T10:00:00.000Z] workspace:ws_1 render in chat: boom\nError: boom\n  at X\n\n')
  })

  it('moves a full log aside before appending', () => {
    const small = memoryFs({ '/l/r.log': 10 })
    appendRotating('/l/r.log', 'abc', 100, small.fs)
    expect(small.calls).toEqual(['append /l/r.log 3'])

    const full = memoryFs({ '/l/r.log': 101 })
    appendRotating('/l/r.log', 'abc', 100, full.fs)
    expect(full.calls).toEqual(['rename /l/r.log /l/r.log.1', 'append /l/r.log 3'])
  })
})
