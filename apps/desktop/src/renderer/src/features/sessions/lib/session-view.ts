import {
  FINISHED_SESSION_STATUSES,
  foldText,
  type Plan,
  type PlanPayload,
  type SessionChangedFile,
  type SessionFileStatus,
  type WorkSession,
  type WorkSessionPayload,
  type WorkSessionStatus,
} from '@milibot/shared'

import { readPref, writePref } from '@/lib/prefs'

export interface SessionFilters {
  status?: WorkSessionStatus
  botId?: string
  /** A project id, or `general`. */
  projectId?: string
}

export function isSessionFinished(status: WorkSessionStatus): boolean {
  return FINISHED_SESSION_STATUSES.includes(status)
}

/** The statuses of a session still going on (listed in the sidebar's "in progress"). */
export const OPEN_SESSION_STATUSES = ['preparing', 'running', 'idle'] as const satisfies WorkSessionStatus[]

/** The session a plan card follows: the one it names, else one of the plan's (older cards name none). */
export function planSession(
  payload: Pick<PlanPayload, 'planId' | 'sessionId'>,
  sessions: Record<string, WorkSession>,
): WorkSession | null {
  if (payload.sessionId) return sessions[payload.sessionId] ?? null
  return Object.values(sessions).find((s) => s.planId === payload.planId) ?? null
}

/** A plan card shows its session (status, activity, changes) once approved to run in one. */
export function planShowsSession(payload: Pick<PlanPayload, 'status' | 'execution' | 'removed'>): boolean {
  if (payload.removed || payload.execution !== 'session') return false
  return payload.status === 'approved' || payload.status === 'executing' || payload.status === 'done'
}

/** The session card is a single line when its plan's card, in the same chat, already follows the session. */
export function sessionCardIsCompact(payload: WorkSessionPayload, conversationId: string): boolean {
  return !payload.removed && Boolean(payload.planId) && payload.planConversationId === conversationId
}

export type ActiveWork =
  { kind: 'session'; id: string; session: WorkSession } | { kind: 'plan'; id: string; plan: Plan }

/** What is going on right now: open sessions, then plans running in their chat, newest first. */
export function activeWork(sessions: WorkSession[], plans: Plan[]): ActiveWork[] {
  const open = sessions
    .filter((s) => !isSessionFinished(s.status))
    .sort((a, b) => b.createdAt - a.createdAt)
    .map((session): ActiveWork => ({ kind: 'session', id: session.id, session }))
  const inChat = plans
    .filter(isPlanRunningInChat)
    .sort((a, b) => (b.decidedAt ?? b.createdAt) - (a.decidedAt ?? a.createdAt))
    .map((plan): ActiveWork => ({ kind: 'plan', id: plan.id, plan }))
  return [...open, ...inChat]
}

export function isPlanRunningInChat(plan: Pick<Plan, 'status' | 'execution'>): boolean {
  return plan.execution === 'chat' && (plan.status === 'approved' || plan.status === 'executing')
}

/** A session pushed by an event belongs in the filtered list. */
export function sessionMatchesFilters(session: WorkSession, filters: SessionFilters): boolean {
  if (filters.status && session.status !== filters.status) return false
  if (filters.botId && session.botId !== filters.botId) return false
  if (filters.projectId === 'general' && session.projectId !== null) return false
  if (filters.projectId && filters.projectId !== 'general' && session.projectId !== filters.projectId)
    return false
  return true
}

export type SessionTone = 'accent' | 'success' | 'danger' | 'muted'

export function sessionTone(status: WorkSessionStatus): SessionTone {
  switch (status) {
    case 'running':
      return 'accent'
    case 'done':
      return 'success'
    case 'failed':
      return 'danger'
    case 'preparing':
    case 'idle':
    case 'cancelled':
      return 'muted'
  }
}

export const FILE_STATUS_LETTER: Record<SessionFileStatus, string> = {
  added: 'A',
  modified: 'M',
  deleted: 'D',
  renamed: 'R',
}

/** Changed files matching the name filter (any part of the path, or where a renamed file came from), by path. */
export function filterChangedFiles(files: SessionChangedFile[], query: string): SessionChangedFile[] {
  const q = foldText(query.trim())
  const matching = q
    ? files.filter(
        (f) => foldText(f.path).includes(q) || (f.oldPath !== undefined && foldText(f.oldPath).includes(q)),
      )
    : files
  return [...matching].sort((a, b) => a.path.localeCompare(b.path))
}

/** The file name and the folder it is in, for a list row. */
export function splitPath(path: string): { name: string; dir: string } {
  const slash = path.lastIndexOf('/')
  return slash < 0 ? { name: path, dir: '' } : { name: path.slice(slash + 1), dir: path.slice(0, slash) }
}

/**
 * A VM path as the chat shows it: without `/workspace/`, a repo's clone or worktree folder reduced to the
 * repo name, and a session folder dropped.
 */
export function shortFilePath(path: string): string {
  const m =
    /^\/workspace\/worktrees\/([^/]+)\/[^/]+\/(.+)$/.exec(path) ??
    /^\/workspace\/repos\/([^/]+)\/(.+)$/.exec(path)
  if (m) return `${m[1]}/${m[2]}`
  const session = /^\/workspace\/sessions\/[^/]+\/(.+)$/.exec(path)
  if (session) return session[1] as string
  return path.startsWith('/workspace/') ? path.slice('/workspace/'.length) : path
}

/** Narrowest the session screen's side panel gets while it is shown. */
const PANEL_MIN_WIDTH = 360
/** Room the session's conversation keeps beside the side panel (the debug panel's width leaves it too). */
const CONVERSATION_MIN_WIDTH = 420

/** Width of the side panel within the session screen's `available` width, leaving room for the conversation. */
export function clampPanelWidth(width: number, available: number): number {
  const max = Math.max(PANEL_MIN_WIDTH, available - CONVERSATION_MIN_WIDTH)
  return Math.round(Math.min(max, Math.max(PANEL_MIN_WIDTH, width)))
}

/**
 * The session's own plan/changes panel steps aside when the screen has no room for it and the conversation
 * together. A panel the user opened there (VM, bot…) stays: their click outweighs the room.
 */
export function sessionPanelCollapsed(available: number | null, openedByUser: boolean): boolean {
  if (openedByUser || available === null) return false
  return available < PANEL_MIN_WIDTH + CONVERSATION_MIN_WIDTH
}

const OVERLAY_MAX_WIDTH = 400
/** Strip of conversation left visible (dimmed) beside the overlaid panel. */
const OVERLAY_GUTTER = 56
const OVERLAY_MIN_WIDTH = 320

/**
 * Width of the collapsed panel opened over the conversation, or null when it takes the session's whole
 * column (it would be narrower than `OVERLAY_MIN_WIDTH`).
 */
export function overlayPanelWidth(available: number): number | null {
  const width = Math.min(OVERLAY_MAX_WIDTH, available - OVERLAY_GUTTER)
  return width < OVERLAY_MIN_WIDTH ? null : Math.round(width)
}

/** Layout choices of the session screen kept in this window's storage (absent or blocked: defaults). */
export function readSessionPref(key: string): string | null {
  return readPref(`milibot.session.${key}`)
}

export function writeSessionPref(key: string, value: string): void {
  writePref(`milibot.session.${key}`, value)
}
