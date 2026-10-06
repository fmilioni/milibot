import { z } from 'zod'

import { BotStatus } from '../bots/bots'
import { Progress } from '../core/schemas'
import { endpoint, Ok } from '../http/endpoint'
import { ModelChoice } from '../models/reasoning'
import { EditedFileStatus } from './file-edits'
import { PlanStep } from './plans'

/*
 * A work session is a bot's long work in a conversation of its own (type `session`), run in a lane of the
 * bot next to its chats; the chat where it started shows a `work_session` card that follows it.
 */

export const WorkSessionStatus = z.enum(['preparing', 'running', 'idle', 'done', 'failed', 'cancelled'])
export type WorkSessionStatus = z.infer<typeof WorkSessionStatus>

/** Sessions the bot closed or the user stopped. */
export const FINISHED_SESSION_STATUSES: readonly WorkSessionStatus[] = ['done', 'failed', 'cancelled']

export const SessionChangeTotals = z.object({
  files: z.number().int(),
  additions: z.number().int(),
  deletions: z.number().int(),
})
export type SessionChangeTotals = z.infer<typeof SessionChangeTotals>

export const SessionFileStatus = EditedFileStatus
export type SessionFileStatus = z.infer<typeof SessionFileStatus>

export const SessionChangedFile = z.object({
  path: z.string(),
  /** Where a renamed file was at the baseline. */
  oldPath: z.string().optional(),
  status: SessionFileStatus,
  additions: z.number().int(),
  deletions: z.number().int(),
  binary: z.boolean(),
})
export type SessionChangedFile = z.infer<typeof SessionChangedFile>

export const SessionChangesUnavailable = z.enum(['no_baseline', 'vm_not_running', 'too_large', 'failed'])
export type SessionChangesUnavailable = z.infer<typeof SessionChangesUnavailable>

/**
 * What the session changed in its folder since it started: against its starting commit (git folder) or a
 * snapshot taken then, uncommitted and untracked files included (.gitignore holds).
 */
export const SessionChanges = z.object({
  available: z.boolean(),
  reason: SessionChangesUnavailable.optional(),
  base: z.string().nullable(),
  files: z.array(SessionChangedFile),
  totals: SessionChangeTotals,
  computedAt: z.number().int(),
})
export type SessionChanges = z.infer<typeof SessionChanges>

export const SessionFileDiff = z.object({
  path: z.string(),
  oldPath: z.string().optional(),
  status: SessionFileStatus,
  binary: z.boolean(),
  /** Unified diff of the file (header and hunks); empty for binary files. */
  patch: z.string(),
  truncated: z.boolean(),
  /** For highlighting, from the extension. */
  language: z.string().optional(),
})
export type SessionFileDiff = z.infer<typeof SessionFileDiff>

const SessionFileDiffQuery = z.object({ path: z.string().min(1) })

const PREVIEWABLE_IMAGE = /\.(png|jpe?g|gif|webp|bmp|ico|avif)$/i

/** Binary files whose changes are shown as the image before and after. */
export function isPreviewableImagePath(path: string): boolean {
  return PREVIEWABLE_IMAGE.test(path)
}

export const SessionImage = z.object({
  bytes: z.number().int(),
  /** Base64 and its type; both absent when it is too large to preview. */
  mediaType: z.string().optional(),
  data: z.string().optional(),
})
export type SessionImage = z.infer<typeof SessionImage>

/** A changed image at the baseline and now (null: the side does not exist or is not an image). */
export const SessionFileImages = z.object({
  before: SessionImage.nullable(),
  after: SessionImage.nullable(),
})
export type SessionFileImages = z.infer<typeof SessionFileImages>

export const WorkSession = z.object({
  id: z.string(),
  botId: z.string(),
  conversationId: z.string(),
  /** Chat where it started (its `work_session` card). */
  originConversationId: z.string(),
  originMessageId: z.string().nullable(),
  planId: z.string().nullable(),
  projectId: z.string().nullable(),
  title: z.string(),
  goal: z.string(),
  status: WorkSessionStatus,
  /** Where the bot works in the VM (its own worktree when `repoName` is set). */
  cwd: z.string().nullable(),
  repoName: z.string().nullable(),
  branch: z.string().nullable(),
  /** null = the bot's own model. */
  model: ModelChoice.nullable(),
  lane: z.object({ status: BotStatus, detail: z.string().nullable() }),
  /** Steps of its plan (or its own list) done or skipped. */
  steps: Progress,
  costUsd: z.number(),
  resultSummary: z.string().nullable(),
  /** The session of the same bot that replaced it (a new session for the same plan or card). */
  replacedBy: z.object({ id: z.string(), title: z.string() }).nullable().optional(),
  /** Last computed totals (null: not computed yet or unavailable). */
  changes: SessionChangeTotals.nullable().optional(),
  /** Helpers (`subagent`): running now and started since the runtime started. */
  subagents: z.object({ running: z.number().int(), total: z.number().int() }).optional(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
  finishedAt: z.number().int().nullable(),
})
export type WorkSession = z.infer<typeof WorkSession>

export const WorkSessionDetail = WorkSession.extend({
  todos: z.array(PlanStep),
})
export type WorkSessionDetail = z.infer<typeof WorkSessionDetail>

export const ListWorkSessionsQuery = z.object({
  botId: z.string().optional(),
  status: WorkSessionStatus.optional(),
  /** A project id, or `general` for sessions without a project. */
  projectId: z.string().optional(),
})
export type ListWorkSessionsQuery = z.input<typeof ListWorkSessionsQuery>

export const workSessionEndpoints = {
  /** Newest first; deleted sessions never appear. */
  listWorkSessions: endpoint({
    method: 'GET',
    path: '/w/:workspaceId/sessions',
    query: ListWorkSessionsQuery,
    response: z.array(WorkSession),
  }),
  getWorkSession: endpoint({
    method: 'GET',
    path: '/w/:workspaceId/sessions/:sessionId',
    response: WorkSessionDetail,
  }),
  /** Stops the session's lane (the bot's chats go on) and marks it cancelled. */
  stopWorkSession: endpoint({
    method: 'POST',
    path: '/w/:workspaceId/sessions/:sessionId/stop',
    response: WorkSession,
  }),
  getWorkSessionChanges: endpoint({
    method: 'GET',
    path: '/w/:workspaceId/sessions/:sessionId/changes',
    response: SessionChanges,
  }),
  getWorkSessionFileDiff: endpoint({
    method: 'GET',
    path: '/w/:workspaceId/sessions/:sessionId/changes/file',
    query: SessionFileDiffQuery,
    response: SessionFileDiff,
  }),
  getWorkSessionFileImages: endpoint({
    method: 'GET',
    path: '/w/:workspaceId/sessions/:sessionId/changes/image',
    query: SessionFileDiffQuery,
    response: SessionFileImages,
  }),
  /** Only finished sessions: hidden with their conversation; the chat card says it was removed. */
  deleteWorkSession: endpoint({
    method: 'DELETE',
    path: '/w/:workspaceId/sessions/:sessionId',
    response: Ok,
  }),
}
