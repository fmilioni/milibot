import { clipLine, clipPatch, type StepFileDiff, unifiedPatch } from '@milibot/shared'

import type { CliToolView } from '../cli/tools'
import { argsObject } from '../tools/args'
import { type DescribeOptions, isNoopCommand } from '../tools/describe'
import type { CommandAction, FileUpdateChange } from './protocol'

/**
 * Names Codex's own tool calls get in `tool_calls` (Milibot's `apply_patch`/`web_search` are other tools, so
 * the prefix keeps them apart).
 */
export const CODEX_TOOLS = {
  exec: 'codex.exec_command',
  patch: 'codex.apply_patch',
  webSearch: 'codex.web_search',
  viewImage: 'codex.view_image',
} as const

const CODEX_TOOL_PREFIX = 'codex.'

/** `/bin/bash -lc '…'` (how Codex reports a shell command) → the command itself. */
export function unwrapShellCommand(command: string): string {
  const m = /^\/(?:usr\/)?bin\/(?:ba|z)?sh\s+-l?c\s+'([\s\S]*)'$/.exec(command.trim())
  return m ? (m[1] as string).replace(/'\\''/g, "'") : command
}

function joinShown(items: string[]): string {
  const shown = items.slice(0, 3).join(', ')
  return items.length > 3 ? `${shown} +${items.length - 3}` : shown
}

function commandView(command: string, actions: CommandAction[], full: boolean): CliToolView {
  if (isNoopCommand(command)) return { hidden: true }
  const clip = full ? (text: string) => text.trim() : (text: string) => clipLine(text, 80)
  const kinds = new Set(actions.map((a) => a.type))
  if (actions.length && kinds.size === 1) {
    const [kind] = kinds
    if (kind === 'read') {
      const names = actions.map((a) => a.path || a.name || '').filter(Boolean)
      if (names.length) return { hidden: false, kind: 'file_read', detail: joinShown(names) }
    }
    if (kind === 'listFiles') {
      return { hidden: false, kind: 'file_list', detail: actions[0]?.path || '.' }
    }
    if (kind === 'search') {
      const a = actions[0] as CommandAction
      const query = clipLine(a.query ?? '', 60)
      if (query) return { hidden: false, kind: 'search', detail: a.path ? `${query} in ${a.path}` : query }
    }
  }
  return { hidden: false, kind: 'bash', detail: clip(command) }
}

/** Activity step (`kind` + human detail) of one of Codex's own tool calls, or hidden; null for other names. */
export function describeCodexTool(
  name: string,
  input: unknown,
  options: DescribeOptions = {},
): CliToolView | null {
  if (!name.startsWith(CODEX_TOOL_PREFIX)) return null
  const a = argsObject(input)
  switch (name) {
    case CODEX_TOOLS.exec:
      return commandView(
        typeof a.command === 'string' ? a.command : '',
        Array.isArray(a.actions) ? (a.actions as CommandAction[]) : [],
        options.full === true,
      )
    case CODEX_TOOLS.patch: {
      const files = Array.isArray(a.files) ? (a.files as Array<{ path?: unknown; kind?: unknown }>) : []
      const paths = files.map((f) => (typeof f.path === 'string' ? f.path : '')).filter(Boolean)
      const allNew = files.length > 0 && files.every((f) => f.kind === 'add')
      return { hidden: false, kind: allNew ? 'file_write' : 'file_edit', detail: joinShown(paths) }
    }
    case CODEX_TOOLS.webSearch:
      return {
        hidden: false,
        kind: 'web_search',
        detail: clipLine(typeof a.query === 'string' ? a.query : '', 80),
      }
    case CODEX_TOOLS.viewImage:
      return { hidden: false, kind: 'file_read', detail: typeof a.path === 'string' ? a.path : '' }
    default:
      return { hidden: true }
  }
}

function hunkCounts(hunks: string): { additions: number; deletions: number } {
  let additions = 0
  let deletions = 0
  for (const line of hunks.split('\n')) {
    if (line.startsWith('@@')) continue
    if (line.startsWith('+')) additions++
    else if (line.startsWith('-')) deletions++
  }
  return { additions, deletions }
}

/** Per-file diffs of a completed `fileChange` item. */
export function codexFileDiffs(changes: readonly FileUpdateChange[]): StepFileDiff[] {
  return changes.map((change) => {
    const kind = change.kind.type
    if (kind === 'add' || kind === 'delete') {
      const diff = kind === 'add' ? unifiedPatch('', change.diff) : unifiedPatch(change.diff, '')
      return {
        path: change.path,
        status: kind === 'add' ? 'added' : 'deleted',
        additions: diff.additions,
        deletions: diff.deletions,
        ...clipPatch(diff.patch),
      }
    }
    const movedTo = change.kind.type === 'update' ? change.kind.move_path : null
    const hunks = change.diff.replace(/\n$/, '')
    return {
      path: movedTo ?? change.path,
      status: movedTo ? 'renamed' : 'modified',
      ...hunkCounts(hunks),
      ...clipPatch(hunks),
    }
  })
}
