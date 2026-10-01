import { clipLine, clipPatch, patchFromHunks, type StepFileDiff, unifiedPatch } from '@milibot/shared'

import type { CliToolView } from '../cli/tools'
import { argsObject } from '../tools/args'
import { type DescribeOptions, isNoopCommand } from '../tools/describe'
import type { ClaudeFileChange } from './stream-json'

/**
 * Claude Code tools that only manage its own loop (tool discovery, todo lists, plan mode, background
 * shell polling, MCP resource listing…). They mean nothing to the user, so they are logged in
 * `tool_calls` but never shown as activity steps.
 */
export const HIDDEN_CLAUDE_CODE_TOOLS: ReadonlySet<string> = new Set([
  'ToolSearch',
  'TodoWrite',
  'TodoRead',
  'TaskCreate',
  'TaskUpdate',
  'TaskList',
  'TaskGet',
  'TaskOutput',
  'TaskStop',
  'BashOutput',
  'KillBash',
  'KillShell',
  'ExitPlanMode',
  'EnterPlanMode',
  'ListMcpResourcesTool',
  'ReadMcpResourceTool',
  'Skill',
  'SlashCommand',
  'AskUserQuestion',
])

function field(input: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const value = input[key]
    if (typeof value === 'string' && value.trim()) return value
  }
  return ''
}

/** Activity step (`kind` + human detail) of one of Claude Code's own tools, or hidden; null for other names. */
export function describeClaudeCodeTool(
  name: string,
  input: unknown,
  options: DescribeOptions = {},
): CliToolView | null {
  if (HIDDEN_CLAUDE_CODE_TOOLS.has(name)) return { hidden: true }
  const clip = options.full ? (text: string, _max?: number) => text.trim() : clipLine
  const a = argsObject(input)
  switch (name) {
    case 'Bash':
      if (isNoopCommand(a.command)) return { hidden: true }
      return { hidden: false, kind: 'bash', detail: clip(field(a, 'command'), 80) }
    case 'Read':
      return { hidden: false, kind: 'file_read', detail: field(a, 'file_path', 'path') }
    case 'Write':
      return { hidden: false, kind: 'file_write', detail: field(a, 'file_path', 'path') }
    case 'Edit':
    case 'MultiEdit':
      return { hidden: false, kind: 'file_edit', detail: field(a, 'file_path', 'path') }
    case 'NotebookEdit':
      return { hidden: false, kind: 'file_edit', detail: field(a, 'notebook_path', 'file_path') }
    case 'LS':
      return { hidden: false, kind: 'file_list', detail: field(a, 'path') || '.' }
    case 'Glob': {
      const where = field(a, 'path')
      return {
        hidden: false,
        kind: 'file_list',
        detail: where ? `${field(a, 'pattern')} in ${where}` : field(a, 'pattern'),
      }
    }
    case 'Grep': {
      const where = field(a, 'path', 'glob')
      const pattern = clip(field(a, 'pattern'), 60)
      return { hidden: false, kind: 'search', detail: where ? `${pattern} in ${where}` : pattern }
    }
    case 'WebFetch':
      return { hidden: false, kind: 'web_fetch', detail: field(a, 'url') }
    case 'WebSearch':
      return { hidden: false, kind: 'web_search', detail: clip(field(a, 'query'), 80) }
    case 'Task':
    case 'Agent':
      return { hidden: false, kind: 'subtask', detail: clip(field(a, 'description', 'prompt'), 80) }
    default:
      return null
  }
}

/**
 * Diff of a successful native Edit/Write: from the `structuredPatch` Claude Code reports, else (older CLIs)
 * rebuilt from Edit's `old_string`/`new_string` without the file's line numbers.
 */
export function claudeCodeFileDiff(
  name: string,
  input: unknown,
  change: ClaudeFileChange | undefined,
): StepFileDiff | null {
  if (name !== 'Edit' && name !== 'MultiEdit' && name !== 'Write') return null
  const a = argsObject(input)
  const path = change?.filePath ?? field(a, 'file_path', 'path')
  if (!path) return null
  let diff: { patch: string; additions: number; deletions: number }
  if (change?.hunks.length) diff = patchFromHunks(change.hunks)
  else if (change?.kind === 'create') diff = unifiedPatch('', change.content ?? '')
  else if (name === 'Edit' && typeof a.old_string === 'string' && typeof a.new_string === 'string') {
    diff = unifiedPatch(a.old_string, a.new_string)
  } else return null
  return {
    path,
    status: change?.kind === 'create' ? 'added' : 'modified',
    additions: diff.additions,
    deletions: diff.deletions,
    ...clipPatch(diff.patch),
  }
}
