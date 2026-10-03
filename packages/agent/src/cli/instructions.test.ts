import { CLI_ENGINE_INFO } from '@milibot/shared'
import { describe, expect, it } from 'vitest'

import type { RepoInstructionFile } from '../environment'
import { splitEngineInstructions } from './instructions'

const file = (path: string, sameAs: string[] = []): RepoInstructionFile => ({
  path,
  bytes: 1,
  truncated: false,
  content: 'x',
  sameAs,
})

const split = (engine: keyof typeof CLI_ENGINE_INFO, files: RepoInstructionFile[]) => {
  const { engine: read, missing } = splitEngineInstructions(CLI_ENGINE_INFO[engine].instructionFiles, files)
  return { read: read.map((f) => f.path), missing: missing.map((f) => f.path) }
}

describe('splitEngineInstructions', () => {
  // Root with both names (different text), app/ with only AGENTS.md, lib/ with only CLAUDE.md, docs/ with the
  // same text under both names.
  const chain = [
    file('/r/CLAUDE.md'),
    file('/r/AGENTS.md'),
    file('/r/app/AGENTS.md'),
    file('/r/app/lib/CLAUDE.md'),
    file('/r/app/lib/docs/CLAUDE.md', ['/r/app/lib/docs/AGENTS.md']),
  ]

  it('Claude Code reads CLAUDE.md: folders with only AGENTS.md are added', () => {
    expect(split('claude_code', chain)).toEqual({
      read: ['/r/CLAUDE.md', '/r/app/lib/CLAUDE.md', '/r/app/lib/docs/CLAUDE.md'],
      missing: ['/r/app/AGENTS.md'],
    })
  })

  it('Codex reads the first of AGENTS.md and CLAUDE.md in each folder: nothing is added', () => {
    expect(split('codex', chain)).toEqual({
      read: ['/r/AGENTS.md', '/r/app/AGENTS.md', '/r/app/lib/CLAUDE.md', '/r/app/lib/docs/CLAUDE.md'],
      missing: [],
    })
  })

  it('Antigravity never reads CLAUDE.md: folders with only CLAUDE.md are added', () => {
    expect(split('antigravity', chain)).toEqual({
      read: ['/r/AGENTS.md', '/r/app/AGENTS.md', '/r/app/lib/docs/CLAUDE.md'],
      missing: ['/r/app/lib/CLAUDE.md'],
    })
  })
})
