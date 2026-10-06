import { ACTIVITY_STEP_KINDS } from '@milibot/shared'
import { describe, expect, it } from 'vitest'

import { describeActivity, describeCliTool } from '../cli/tools'
import { TOOL_DEFINITIONS } from '../tools/catalog'
import { activityLine, describeToolCall, isNoopToolCall } from '../tools/describe'

describe('describeCliTool with Claude Code tools', () => {
  it('hides Claude Code internal tools', () => {
    for (const name of ['ToolSearch', 'TodoWrite', 'ExitPlanMode', 'BashOutput', 'ListMcpResourcesTool']) {
      expect(describeCliTool(name, { query: 'select:mcp__milibot__computer' })).toEqual({
        hidden: true,
      })
    }
  })

  it('humanizes native tools', () => {
    expect(describeCliTool('Bash', { command: 'ls -la /workspace', description: 'List' })).toEqual({
      hidden: false,
      kind: 'bash',
      detail: 'ls -la /workspace',
    })
    expect(describeCliTool('Read', { file_path: '/workspace/a.ts' })).toMatchObject({
      kind: 'file_read',
      detail: '/workspace/a.ts',
    })
    expect(describeCliTool('Edit', { file_path: '/workspace/a.ts', old_string: 'x' })).toMatchObject({
      kind: 'file_edit',
      detail: '/workspace/a.ts',
    })
    expect(describeCliTool('MultiEdit', { file_path: '/workspace/b.ts' })).toMatchObject({
      kind: 'file_edit',
    })
    expect(describeCliTool('Write', { file_path: '/workspace/c.md', content: '# hi' })).toMatchObject({
      kind: 'file_write',
      detail: '/workspace/c.md',
    })
    expect(describeCliTool('Grep', { pattern: 'TODO', path: '/workspace/src' })).toMatchObject({
      kind: 'search',
      detail: 'TODO in /workspace/src',
    })
    expect(describeCliTool('Glob', { pattern: '**/*.ts' })).toMatchObject({
      kind: 'file_list',
      detail: '**/*.ts',
    })
    expect(
      describeCliTool('WebFetch', { url: 'https://www.debian.org/News/', prompt: 'release date?' }),
    ).toMatchObject({ kind: 'web_fetch', detail: 'https://www.debian.org/News/' })
    expect(describeCliTool('WebSearch', { query: 'debian 13 release date' })).toMatchObject({
      kind: 'web_search',
      detail: 'debian 13 release date',
    })
    expect(describeCliTool('Task', { description: 'Research prices', prompt: '…' })).toMatchObject({
      kind: 'subtask',
      detail: 'Research prices',
    })
    expect(describeCliTool('SomethingNew', { a: 1 })).toEqual({
      hidden: false,
      kind: 'tool',
      detail: 'Something New',
    })
  })

  it('renders Milibot MCP tools like the native computer tool', () => {
    expect(describeCliTool('mcp__milibot__computer', { action: 'click', x: 640, y: 772 })).toEqual({
      hidden: false,
      kind: 'click',
      detail: '(640, 772)',
    })
    expect(describeCliTool('mcp__milibot__computer', { action: 'type', text: 'hi' })).toMatchObject({
      kind: 'type',
      detail: 'hi',
    })
    expect(describeCliTool('mcp__milibot__computer', { action: 'screenshot' })).toMatchObject({
      kind: 'screenshot',
    })
    expect(describeCliTool('mcp__milibot__create_bot', { name: 'Iris' })).toMatchObject({
      kind: 'create_bot',
      detail: 'Iris',
    })
  })

  it('writes readable summary lines', () => {
    expect(activityLine('bash', 'ls')).toBe('terminal: ls')
    expect(activityLine('file_read', '/workspace/a.ts')).toBe('read: /workspace/a.ts')
    expect(activityLine('screenshot', '')).toBe('screenshot')
    expect(activityLine('click', '(640, 772)')).toBe('click: (640, 772)')
  })
})

describe('activity steps of every tool', () => {
  const kinds = new Set<string>(ACTIVITY_STEP_KINDS)
  const odd = { command: { x: 1 }, path: ['a'], name: { a: 1 }, bot: 7, url: null, text: {}, actions: 'x' }

  it('gives every Milibot tool a known kind and never raw arguments, with any arguments', () => {
    for (const name of Object.keys(TOOL_DEFINITIONS)) {
      for (const args of [{}, null, odd]) {
        const view = describeActivity(name, args)
        if (view.hidden) continue
        expect(kinds.has(view.kind), `${name} → ${view.kind}`).toBe(true)
        expect(view.detail).not.toMatch(/^[[{]|^true$|^null$/)
      }
    }
    expect(describeToolCall('list_bots', {})).toEqual({ kind: 'list_bots', detail: '' })
    expect(describeToolCall('get_bot', { bot: 'Ana' })).toEqual({ kind: 'get_bot', detail: 'Ana' })
    expect(describeToolCall('computer', { action: 'hover' })).toEqual({ kind: 'click', detail: '' })
    expect(describeToolCall('browser_tabs', { action: 'pin' })).toEqual({ kind: 'browser_tabs', detail: '' })
    expect(describeToolCall('some_future_tool', { a: 1 })).toEqual({ kind: 'some_future_tool', detail: '' })
  })

  it('gives every Claude Code native tool a known kind and hides no-op commands', () => {
    const natives = ['Bash', 'Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'LS', 'Glob', 'Grep']
    for (const name of [...natives, 'WebFetch', 'WebSearch', 'Task', 'Agent', 'NewTool', 'mcp__gh__list']) {
      const view = describeCliTool(name, { command: 'ls', file_path: '/a', pattern: 'x', url: 'u' })
      if (view.hidden) throw new Error(`${name} hidden`)
      expect(kinds.has(view.kind), `${name} → ${view.kind}`).toBe(true)
    }
    for (const command of ['true', ':', '', '  ', 'true;', 'exit 0', undefined])
      expect(describeCliTool('Bash', { command })).toEqual({ hidden: true })
    expect(describeCliTool('Bash', { command: 'true && make' })).toMatchObject({ kind: 'bash' })
    expect(describeCliTool('mcp__milibot__list_bots', {})).toEqual({
      hidden: false,
      kind: 'list_bots',
      detail: '',
    })
    expect(describeActivity('bash', { command: 'true' })).toEqual({ hidden: true })
    expect(isNoopToolCall('bash', { command: 'true' })).toBe(true)
    expect(isNoopToolCall('bash', { command: 'ls' })).toBe(false)
  })
})
