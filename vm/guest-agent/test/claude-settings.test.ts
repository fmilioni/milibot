import { describe, expect, it } from 'vitest'

import { AGENT_HOME, CLAUDE_SETTINGS, ensureClaudeSettings, type SettingsFs } from '../src/claude-settings.ts'

const AGENT = { uid: 1500, gid: 1500 }

function memoryFs(
  files: Record<string, string>,
  agent = true,
): SettingsFs & { files: Record<string, string>; ops: string[] } {
  const ops: string[] = []
  return {
    files,
    ops,
    read: (path) => files[path] ?? null,
    owner: (path) => (agent && path === AGENT_HOME ? AGENT : null),
    mkdir: (path, owner) => void ops.push(`mkdir ${path} ${owner.uid}`),
    write(path, content, owner) {
      ops.push(`write ${path} ${owner.uid}`)
      files[path] = content
    },
  }
}

describe('ensureClaudeSettings', () => {
  it('creates the settings owned by agent when Claude Code was never configured', () => {
    const io = memoryFs({})
    expect(ensureClaudeSettings(io)).toBe('written')
    expect(JSON.parse(io.files[CLAUDE_SETTINGS]!)).toEqual({ outputStyle: 'Concise' })
    expect(io.ops).toEqual([`mkdir ${AGENT_HOME}/.claude 1500`, `write ${CLAUDE_SETTINGS} 1500`])
  })

  it('keeps the existing keys and a style chosen by hand', () => {
    const io = memoryFs({ [CLAUDE_SETTINGS]: '{"model":"opus","env":{"A":"1"}}' })
    expect(ensureClaudeSettings(io)).toBe('written')
    expect(JSON.parse(io.files[CLAUDE_SETTINGS]!)).toEqual({
      model: 'opus',
      env: { A: '1' },
      outputStyle: 'Concise',
    })

    const manual = memoryFs({ [CLAUDE_SETTINGS]: '{"outputStyle":"Explanatory"}' })
    expect(ensureClaudeSettings(manual)).toBe('unchanged')
    expect(manual.ops).toEqual([])
  })

  it('is idempotent', () => {
    const io = memoryFs({})
    ensureClaudeSettings(io)
    io.ops.length = 0
    expect(ensureClaudeSettings(io)).toBe('unchanged')
    expect(io.ops).toEqual([])
  })

  it('never touches a file it cannot parse, nor a VM without agent', () => {
    for (const content of ['{"model":', '[]', 'null']) {
      const io = memoryFs({ [CLAUDE_SETTINGS]: content })
      expect(ensureClaudeSettings(io)).toBe('invalid')
      expect(io.files[CLAUDE_SETTINGS]).toBe(content)
    }
    expect(ensureClaudeSettings(memoryFs({}, false))).toBe('no_agent')
  })
})
