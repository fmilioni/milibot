import { TOOL_NAMES, toolText } from '@milibot/agent/tools'
import { describe, expect, it } from 'vitest'

import { toolOwnershipProblems, ToolRegistry } from '../../../src/runtime/composition/tool-registry'
import { createWorkspaceRuntime } from '../../../src/runtime/runtime'
import type { ToolProvider } from '../../../src/runtime/tools-core'
import { openWorkspaceDb } from '../../../src/workspace-db/open'

const provider = (name: string, tools: string[]): ToolProvider => ({
  name,
  handles: (tool) => tools.includes(tool),
  execute: async () => toolText(name),
})

describe('tool ownership', () => {
  it('gives every catalog tool exactly one owner in a real runtime', () => {
    const runtime = createWorkspaceRuntime({
      workspaceId: 'ws_tools',
      db: openWorkspaceDb(':memory:'),
      emit: () => {},
    })
    const wrong = TOOL_NAMES.map((tool) => ({ tool, owners: runtime.services.tools.owners(tool) })).filter(
      (entry) => entry.owners.length !== 1,
    )
    expect(wrong).toEqual([])
  })

  it('reports tools nobody runs and tools two providers claim', () => {
    const problems = toolOwnershipProblems(
      [provider('a', ['one', 'two']), provider('b', ['two'])],
      ['one', 'two', 'three', 'memo'],
      ['memo'],
    )
    expect(problems).toEqual(['two: a, b', 'three: no provider'])
  })

  it('refuses to build a registry with gaps', () => {
    expect(() => new ToolRegistry([provider('a', [])], (v) => v)).toThrow(/tool ownership/)
  })
})
