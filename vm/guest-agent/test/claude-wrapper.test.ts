import { describe, expect, it } from 'vitest'

import { CLAUDE_BIN, CLAUDE_REAL, ensureClaudeWrapper, type WrapperFs } from '../src/claude-wrapper.ts'
import { CLI_WRAPPER } from '../src/guest-files.ts'

function memoryFs(
  files: Record<string, string>,
): WrapperFs & { files: Record<string, string>; ops: string[] } {
  const ops: string[] = []
  return {
    files,
    ops,
    readHead: (path, max) => (path in files ? files[path]!.slice(0, max) : null),
    exists: (path) => path in files,
    mkdirp: (path) => void ops.push(`mkdir ${path}`),
    link(from, to) {
      ops.push(`link ${from} ${to}`)
      files[to] = files[from]!
    },
    rename(from, to) {
      ops.push(`rename ${from} ${to}`)
      files[to] = files[from]!
      delete files[from]
    },
    unlink: (path) => void delete files[path],
    writeExecutable(path, content) {
      ops.push(`write ${path}`)
      files[path] = content
    },
  }
}

describe('ensureClaudeWrapper', () => {
  it('moves a real binary aside and puts the wrapper in its place, never leaving a gap', () => {
    const io = memoryFs({ [CLAUDE_BIN]: '\x7fELF binary' })
    expect(ensureClaudeWrapper(io)).toBe('installed')
    expect(io.files[CLAUDE_REAL]).toBe('\x7fELF binary')
    expect(io.files[CLAUDE_BIN]).toBe(CLI_WRAPPER)
    expect(io.ops).toEqual([
      'mkdir /usr/local/lib/milibot',
      `link ${CLAUDE_BIN} ${CLAUDE_REAL}.milibot-new`,
      `rename ${CLAUDE_REAL}.milibot-new ${CLAUDE_REAL}`,
      `write ${CLAUDE_BIN}.milibot-new`,
      `rename ${CLAUDE_BIN}.milibot-new ${CLAUDE_BIN}`,
    ])
  })

  it('leaves a current wrapper alone and rewrites a changed one', () => {
    const io = memoryFs({ [CLAUDE_BIN]: CLI_WRAPPER, [CLAUDE_REAL]: 'bin' })
    expect(ensureClaudeWrapper(io)).toBe('unchanged')
    expect(io.ops).toEqual([])
    io.files[CLAUDE_BIN] = '#!/bin/bash\n# milibot-cli-wrapper\nexec old\n'
    expect(ensureClaudeWrapper(io)).toBe('updated')
    expect(io.files[CLAUDE_BIN]).toBe(CLI_WRAPPER)
    expect(io.files[CLAUDE_REAL]).toBe('bin')
  })

  it('restores a missing wrapper and does nothing without Claude Code', () => {
    const io = memoryFs({ [CLAUDE_REAL]: 'bin' })
    expect(ensureClaudeWrapper(io)).toBe('installed')
    expect(io.files[CLAUDE_BIN]).toBe(CLI_WRAPPER)
    expect(ensureClaudeWrapper(memoryFs({}))).toBe('no_claude')
  })
})
