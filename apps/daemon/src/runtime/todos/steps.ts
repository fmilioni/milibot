import { ToolInputError, trimmedString } from '@milibot/agent/tools'
import { planProgress, TodoStatus } from '@milibot/shared'

import { foldKey } from '../tools-core'
import type { TodoRow } from './store'

const MAX_TODOS = 60

export const CHECKBOX: Record<TodoStatus, string> = {
  pending: '[ ]',
  in_progress: '[~]',
  done: '[x]',
  skipped: '[-]',
}

interface ParsedTodo {
  id?: string
  title: string
  detail: string | null
  status: TodoStatus
  note: string | null
}

/**
 * The list given to todo_write merged into the existing steps (matched by id, else by title). Steps left out
 * stay as they are, so a partial list never deletes steps (dropping one takes `skipped`); a new step goes
 * after the step listed before it. When every existing step is listed, the list's order wins.
 */
export function parseTodos(value: unknown, existing: TodoRow[]): ParsedTodo[] {
  if (!Array.isArray(value) || value.length === 0) throw new ToolInputError('"todos" must list 1 to 60 steps')
  if (value.length > MAX_TODOS) throw new ToolInputError(`at most ${MAX_TODOS} steps`)
  const given = matchTodos(value, existing)
  const listed = new Set(given.flatMap((t) => (t.id ? [t.id] : [])))
  if (existing.every((e) => listed.has(e.id))) return given
  const updates = new Map(given.flatMap((t) => (t.id ? [[t.id, t] as const] : [])))
  const merged: ParsedTodo[] = existing.map(
    (e) =>
      updates.get(e.id) ?? { id: e.id, title: e.title, detail: e.detail, status: e.status, note: e.note },
  )
  let anchor = -1
  for (const t of given) {
    if (t.id) anchor = merged.findIndex((m) => m.id === t.id)
    else merged.splice(++anchor, 0, t)
  }
  if (merged.length > MAX_TODOS) throw new ToolInputError(`at most ${MAX_TODOS} steps`)
  return merged
}

function matchTodos(value: unknown[], existing: TodoRow[]): ParsedTodo[] {
  const byId = new Map(existing.map((t) => [t.id, t]))
  const used = new Set<string>()
  return value.map((raw, i) => {
    const t = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
    const title = trimmedString(t.title).slice(0, 300)
    if (!title) throw new ToolInputError(`todos[${i}].title is empty`)
    const status = TodoStatus.safeParse(t.status)
    if (!status.success)
      throw new ToolInputError(`todos[${i}].status must be pending, in_progress, done or skipped`)
    const given = trimmedString(t.id)
    const match =
      (given && byId.has(given) && !used.has(given) ? given : null) ??
      existing.find((e) => !used.has(e.id) && foldKey(e.title) === foldKey(title))?.id ??
      null
    if (match) used.add(match)
    const previous = match ? byId.get(match) : undefined
    const note = trimmedString(t.note).slice(0, 1000)
    return {
      ...(match ? { id: match } : {}),
      title,
      detail: previous?.detail ?? null,
      status: status.data,
      note: note || previous?.note || null,
    }
  })
}

/** Nudge after a step list changed: `finished` once every step is done or skipped. */
export function progressTail(todos: Array<{ status: TodoStatus }>, finished: string): string {
  const progress = planProgress(todos)
  const active = todos.filter((t) => t.status === 'in_progress')
  return progress.done === progress.total
    ? finished
    : active.length > 1
      ? 'Keep only one step in_progress at a time.'
      : active.length === 0
        ? 'Mark the step you work on next as in_progress.'
        : ''
}
