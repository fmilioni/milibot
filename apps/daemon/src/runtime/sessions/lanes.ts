import { describeCliTool } from '@milibot/agent/cli'
import { describeToolCall, isToolName } from '@milibot/agent/tools'
import { type BotStatus, type Message, planProgress, type PlanStep, type ToolCallRow } from '@milibot/shared'

import { CHECKBOX } from '../todos'
import { oneLine } from '../tools-core'
import type { WorkspaceStore } from '../workspace-store'
import { storedChanges } from './changes'
import { diffstatLines } from './diff'
import type { SessionRow, SessionStore } from './store'

const RECOVERY_MESSAGES_CHARS = 10_000
const RECOVERY_ACTIONS = 20

export interface SessionLanesDeps {
  sessions: SessionStore
  store: WorkspaceStore
  /** Tool calls of a conversation, oldest first (the last `limit`). */
  toolCalls: (conversationId: string, limit: number) => ToolCallRow[]
  steps: (row: SessionRow) => PlanStep[]
  revokeLane: (laneKey: string) => void
  /** The session changed: `soon` batches frequent updates. */
  changed: (sessionId: string, soon?: boolean) => void
}

/**
 * What the lanes of the sessions report and read: their live status and helpers (not stored: every lane is idle
 * after a restart), the state block the bot sees each turn, and the recovery text for a fresh CLI session.
 */
export class SessionLanes {
  private readonly lanes = new Map<string, { status: BotStatus; detail: string | null }>()
  private readonly helpers = new Map<string, { running: number; total: number }>()

  constructor(private readonly deps: SessionLanesDeps) {}

  lane(sessionId: string): { status: BotStatus; detail: string | null } {
    const lane = this.lanes.get(sessionId)
    return { status: lane?.status ?? 'idle', detail: lane?.detail ?? null }
  }

  subagents(sessionId: string): { running: number; total: number } {
    return this.helpers.get(sessionId) ?? { running: 0, total: 0 }
  }

  forget(sessionId: string): void {
    this.lanes.delete(sessionId)
    this.helpers.delete(sessionId)
  }

  setStatus(sessionId: string, status: BotStatus, detail: string | null): void {
    const previous = this.lanes.get(sessionId)
    if (previous?.status === status && previous.detail === detail) return
    this.lanes.set(sessionId, { status, detail })
    const row = this.deps.sessions.row(sessionId)
    if (!row) return
    if (status !== 'idle' && (row.status === 'preparing' || row.status === 'idle')) {
      this.deps.sessions.update(sessionId, { status: 'running' })
      this.deps.changed(sessionId)
      return
    }
    this.deps.changed(sessionId, previous?.status === status)
  }

  subagentsChanged(sessionId: string, counts: { running: number; total: number }, endedLane?: string): void {
    this.helpers.set(sessionId, counts)
    if (endedLane) this.deps.revokeLane(endedLane)
    if (this.deps.sessions.row(sessionId)) this.deps.changed(sessionId)
  }

  /** A new CLI session of the lane starts: returns the generation it replaces. */
  cliStarted(sessionId: string): number {
    const row = this.deps.sessions.row(sessionId)
    if (!row) return 0
    this.deps.sessions.update(sessionId, { cli_generation: row.cli_generation + 1 })
    return row.cli_generation
  }

  /** Steps and changed files, as the bot reads them each turn. */
  stateText(sessionId: string): string {
    const row = this.deps.sessions.row(sessionId)
    if (!row) return ''
    const parts: string[] = []
    const steps = this.deps.steps(row)
    if (steps.length) {
      const progress = planProgress(steps)
      parts.push(
        [
          `Steps (${progress.done}/${progress.total} done):`,
          ...steps.map(
            (s) => `${CHECKBOX[s.status]} ${s.title}${s.note ? ` — ${oneLine(s.note, 160)}` : ''}`,
          ),
        ].join('\n'),
      )
    }
    const changes = storedChanges(row)
    if (changes?.files.length) {
      const { files, additions, deletions } = changes.totals
      parts.push(
        [
          `Files changed since the session started (${files}, +${additions} −${deletions}):`,
          ...diffstatLines(changes.files),
        ].join('\n'),
      )
    }
    return parts.join('\n\n')
  }

  /** How far the session went, for a fresh CLI session picking it up. */
  recovery(sessionId: string): string {
    const row = this.deps.sessions.row(sessionId)
    if (!row) return ''
    const parts = [
      '# Where this session stands\nYour earlier session on this work ended; continue from here.',
    ]
    const state = this.stateText(sessionId)
    if (state) parts.push(state)
    const messages = this.deps.store.messages
      .list(row.conversation_id, { limit: 60 })
      .messages.filter((m) => m.kind === 'text' && m.content.trim())
    const lines: string[] = []
    let used = 0
    for (let i = messages.length - 1; i >= 0 && used < RECOVERY_MESSAGES_CHARS; i--) {
      const m = messages[i] as Message
      const line = `${m.authorType === 'user' ? 'User' : 'You'}: ${oneLine(m.content, 1200)}`
      used += line.length
      lines.unshift(line)
    }
    if (lines.length) parts.push(`Last messages of the session:\n${lines.join('\n')}`)
    const actions = this.deps.toolCalls(row.conversation_id, RECOVERY_ACTIONS).flatMap((a) => {
      const args = a.arguments ?? {}
      const view = isToolName(a.toolName)
        ? { hidden: false as const, ...describeToolCall(a.toolName, args) }
        : describeCliTool(a.toolName, args)
      if (view.hidden) return []
      return [
        `- ${a.toolName}${view.detail ? `: ${oneLine(view.detail, 160)}` : ''}${a.status === 'error' ? ' (failed)' : ''}`,
      ]
    })
    if (actions.length) parts.push(`Your last actions:\n${actions.join('\n')}`)
    return parts.join('\n\n')
  }
}
