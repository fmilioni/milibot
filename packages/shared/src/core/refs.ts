import { z } from 'zod'

import { endpoint } from '../http/endpoint'
import { ID_PREFIXES } from './ids'

/**
 * Ids written in text (chat, cards, comments, plans) that open a screen of the app. Ids without one
 * (messages, attachments, memories…) stay plain text.
 */
export const REF_KINDS = {
  card: ID_PREFIXES.boardCard,
  board: ID_PREFIXES.board,
  design: ID_PREFIXES.design,
  frame: ID_PREFIXES.designFrame,
  plan: ID_PREFIXES.plan,
  session: ID_PREFIXES.workSession,
  doc: ID_PREFIXES.knowledgeDoc,
  project: ID_PREFIXES.project,
  skill: ID_PREFIXES.skill,
  routine: ID_PREFIXES.routine,
  conversation: ID_PREFIXES.conversation,
  bot: ID_PREFIXES.bot,
} as const

export type RefKind = keyof typeof REF_KINDS
export const RefKind = z.enum(Object.keys(REF_KINDS) as [RefKind, ...RefKind[]])

const KIND_BY_PREFIX = new Map<string, RefKind>(
  Object.entries(REF_KINDS).map(([kind, prefix]) => [prefix, kind as RefKind]),
)

/** A lowercase ULID (Crockford's alphabet: no i, l, o, u), as `newId` writes it. */
const ULID = '[0-9a-hjkmnp-tv-z]{26}'
const WORD = '[\\p{L}\\p{N}_-]'
const prefixes = [...KIND_BY_PREFIX.keys()].sort((a, b) => b.length - a.length).join('|')

/**
 * An id in running text: prefix + `_` + 26 ULID characters, not glued to a word, so tool names
 * (`plan_submit`), slugs (`bot-theo`) and longer or uppercase strings never match.
 */
export const REF_ID_PATTERN = new RegExp(`(?<!${WORD})(?:${prefixes})_${ULID}(?!${WORD})`, 'gu')

const WHOLE_ID = new RegExp(`^(${prefixes})_${ULID}$`)

/** The kind of a whole id, or null when it isn't one the app links. */
export function refKindOf(id: string): RefKind | null {
  const match = WHOLE_ID.exec(id)
  return match ? (KIND_BY_PREFIX.get(match[1] as string) ?? null) : null
}

/** A file path in the VM's shared folder, as written in text (no spaces: they end it). */
export const WORKSPACE_PATH_PATTERN = /(?<![\p{L}\p{N}_./~-])\/workspace\/[^\s<>"'`|]+/gu

/** An absolute path inside `/workspace/` with no `.`/`..` segments, empty segments or trailing slash. */
export function isWorkspaceFilePath(path: string): boolean {
  if (!path.startsWith('/workspace/') || path.endsWith('/') || path.includes('\0')) return false
  return path
    .slice('/workspace/'.length)
    .split('/')
    .every((segment) => segment !== '' && segment !== '.' && segment !== '..')
}

export const RefInfo = z.object({
  id: z.string(),
  kind: RefKind,
  /** The item's current name. */
  name: z.string(),
  /** card → its board. */
  boardId: z.string().optional(),
  /** frame → its design. */
  designId: z.string().optional(),
  /** routine → its bot; direct conversation → its bot. */
  botId: z.string().optional(),
  conversationType: z.enum(['direct', 'group', 'internal', 'session']).optional(),
  /** session conversation → its work session. */
  sessionId: z.string().optional(),
})
export type RefInfo = z.infer<typeof RefInfo>

export const MAX_REFS_PER_RESOLVE = 200

const ResolveRefsBody = z.object({ ids: z.array(z.string().max(64)).min(1).max(MAX_REFS_PER_RESOLVE) })

const ExportWorkspaceFileBody = z.object({ path: z.string().min(1).max(4096) })

export const refEndpoints = {
  /** The ids that exist and aren't deleted, with their current names; the others are left out. */
  resolveRefs: endpoint({
    method: 'POST',
    path: '/w/:workspaceId/refs/resolve',
    body: ResolveRefsBody,
    response: z.object({ refs: z.array(RefInfo) }),
  }),
  /**
   * Copies a file under `/workspace/` to a temporary folder on the host (to open it). Never boots the VM:
   * `VM_NOT_RUNNING`, `FILE_REMOVED`, `NOT_A_FILE`, `FILE_TOO_LARGE`.
   */
  exportWorkspaceFile: endpoint({
    method: 'POST',
    path: '/w/:workspaceId/workspace-files/export',
    body: ExportWorkspaceFileBody,
    response: z.object({ path: z.string() }),
  }),
}
