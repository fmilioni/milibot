import type { ToolCallFinish, ToolCallStart } from '@milibot/agent'
import { describeActivity, HIDDEN_CLAUDE_CODE_TOOLS } from '@milibot/agent/cli'
import { type BotActivityAction, type StepDiff, type StepFileDiff, type ToolCallRow } from '@milibot/shared'

import { type Db, parseJson } from '../../db/sqlite'
import { notFound } from '../../errors'

interface ToolCallDbRow {
  id: string
  llm_call_id: string | null
  bot_id: string | null
  conversation_id: string | null
  turn_id: string | null
  tool_name: string
  arguments_json: string | null
  result_json: string | null
  status: ToolCallRow['status']
  error: string | null
  screenshot_hash: string | null
  started_at: number
  finished_at: number | null
}

function json(value: unknown): string | null {
  return value === undefined || value === null ? null : JSON.stringify(value)
}

/** Step detail the tool reported after running (`ToolResult.activity`), kept in the stored result. */
function resultDetail(result: unknown): string | null {
  const detail = (result as { detail?: unknown } | null)?.detail
  return typeof detail === 'string' ? detail : null
}

/** The `tool_calls` log, the file diffs of tool calls and the bots' activity read from it. */
export class ToolCallStore {
  constructor(private readonly db: Db) {}

  /** Arguments of the calls of `tool` that succeeded since `since`, with their bot. */
  succeededCalls(tool: string, since: number): Array<{ botId: string | null; args: unknown }> {
    return (
      this.db
        .prepare(
          `SELECT bot_id, arguments_json FROM tool_calls WHERE tool_name = ? AND status = 'ok' AND started_at >= ?`,
        )
        .all(tool, since) as Array<{ bot_id: string | null; arguments_json: string | null }>
    ).map((r) => ({ botId: r.bot_id, args: parseJson<unknown>(r.arguments_json ?? 'null', null) }))
  }

  start(record: ToolCallStart): void {
    this.db
      .prepare(
        `INSERT INTO tool_calls (id, llm_call_id, bot_id, conversation_id, turn_id, tool_name, arguments_json, status, started_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'running', ?)`,
      )
      .run(
        record.id,
        record.llmCallId,
        record.botId,
        record.conversationId,
        record.turnId,
        record.toolName,
        json(record.arguments),
        record.startedAt,
      )
  }

  finish(id: string, finish: ToolCallFinish): void {
    this.db
      .prepare(
        `UPDATE tool_calls SET status = ?, result_json = ?, error = ?, screenshot_hash = ?, finished_at = ? WHERE id = ?`,
      )
      .run(finish.status, json(finish.result), finish.error, finish.screenshotSha, finish.finishedAt, id)
  }

  saveDiff(toolCallId: string, files: StepFileDiff[], at: number): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO tool_call_diffs (tool_call_id, conversation_id, files_json, created_at)
         VALUES (?, (SELECT conversation_id FROM tool_calls WHERE id = ?), ?, ?)`,
      )
      .run(toolCallId, toolCallId, JSON.stringify(files), at)
  }

  getDiff(toolCallId: string): StepDiff {
    const row = this.db
      .prepare('SELECT files_json FROM tool_call_diffs WHERE tool_call_id = ?')
      .get(toolCallId) as { files_json: string } | undefined
    if (!row) throw notFound('tool call diff', toolCallId)
    return { toolCallId, files: parseJson<StepFileDiff[]>(row.files_json, []) }
  }

  private toToolCall(r: ToolCallDbRow): ToolCallRow {
    const args = parseJson<unknown>(r.arguments_json, null)
    const view = describeActivity(r.tool_name, args)
    const result = parseJson<unknown>(r.result_json, null)
    return {
      ...(view.hidden ? { hidden: true } : { kind: view.kind, detail: resultDetail(result) ?? view.detail }),
      id: r.id,
      llmCallId: r.llm_call_id,
      botId: r.bot_id,
      conversationId: r.conversation_id,
      turnId: r.turn_id,
      toolName: r.tool_name,
      arguments: args,
      result,
      status: r.status,
      error: r.error,
      screenshotSha: r.screenshot_hash,
      startedAt: r.started_at,
      finishedAt: r.finished_at,
    }
  }

  list(conversationId: string, options: { limit: number; turnId?: string | undefined }): ToolCallRow[] {
    const rows = (
      options.turnId
        ? this.db
            .prepare(
              'SELECT * FROM tool_calls WHERE conversation_id = ? AND turn_id = ? ORDER BY started_at DESC, id DESC LIMIT ?',
            )
            .all(conversationId, options.turnId, options.limit)
        : this.db
            .prepare(
              'SELECT * FROM tool_calls WHERE conversation_id = ? ORDER BY started_at DESC, id DESC LIMIT ?',
            )
            .all(conversationId, options.limit)
    ) as ToolCallDbRow[]
    return rows.reverse().map((r) => this.toToolCall(r))
  }

  /** Most recent first. */
  botActivity(botId: string, limit: number): BotActivityAction[] {
    const hidden = [...HIDDEN_CLAUDE_CODE_TOOLS]
    const rows = this.db
      .prepare(
        `SELECT * FROM tool_calls WHERE bot_id = ? AND tool_name NOT IN (${hidden.map(() => '?').join(', ')})
         ORDER BY started_at DESC, id DESC LIMIT ?`,
      )
      .all(botId, ...hidden, limit) as ToolCallDbRow[]
    return rows.flatMap((r): BotActivityAction[] => {
      const args = parseJson<unknown>(r.arguments_json, null)
      const view = describeActivity(r.tool_name, args)
      if (view.hidden) return []
      const refined = resultDetail(parseJson<unknown>(r.result_json, null))
      const { kind } = view
      const detail = refined ?? view.detail
      const full = describeActivity(r.tool_name, args, { full: true })
      const fullDetail = !refined && !full.hidden && full.detail !== detail ? full.detail : undefined
      const action: BotActivityAction = {
        id: r.id,
        botId,
        conversationId: r.conversation_id,
        turnId: r.turn_id,
        time: r.started_at,
        tool: r.tool_name,
        kind,
        detail,
        status: r.status,
        durationMs: r.finished_at === null ? null : r.finished_at - r.started_at,
        error: r.error,
        screenshotSha: r.screenshot_hash,
      }
      if (fullDetail !== undefined) action.fullDetail = fullDetail
      return [action]
    })
  }
}
