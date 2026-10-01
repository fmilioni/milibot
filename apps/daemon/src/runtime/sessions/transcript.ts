import { messageTokens, type TranscriptEntry } from '@milibot/agent'
import type { ChatMessage } from '@milibot/agent/llm'
import { estimateTokens, newId } from '@milibot/shared'

import { type Db, parseJson } from '../../db/sqlite'

/** The transcript of API-provider bots' session lanes, with its rolling summary (`session_transcript`). */
export class SessionTranscript {
  constructor(
    private readonly db: Db,
    private readonly now: () => number,
  ) {}

  load(sessionId: string, laneKey: string): { summary: string | null; entries: TranscriptEntry[] } {
    const summary = this.db
      .prepare(
        `SELECT content, to_seq FROM session_summaries WHERE session_id = ? AND lane_key = ?
         ORDER BY to_seq DESC LIMIT 1`,
      )
      .get(sessionId, laneKey) as { content: string; to_seq: number } | undefined
    const rows = this.db
      .prepare(
        `SELECT seq, message FROM session_transcript
         WHERE session_id = ? AND lane_key = ? AND compacted = 0 AND seq > ? ORDER BY seq`,
      )
      .all(sessionId, laneKey, summary?.to_seq ?? 0) as Array<{ seq: number; message: string }>
    return {
      summary: summary?.content ?? null,
      entries: rows.flatMap((r) => {
        const message = parseJson<ChatMessage | null>(r.message, null)
        return message ? [{ seq: r.seq, message }] : []
      }),
    }
  }

  append(sessionId: string, laneKey: string, turnId: string | null, message: ChatMessage): number {
    if (message.role === 'system') return -1
    const result = this.db
      .prepare(
        `INSERT INTO session_transcript (session_id, lane_key, turn_id, role, message, tokens, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        sessionId,
        laneKey,
        turnId,
        message.role,
        JSON.stringify(message),
        messageTokens(message),
        this.now(),
      )
    return Number(result.lastInsertRowid)
  }

  compact(
    sessionId: string,
    laneKey: string,
    toSeq: number,
    summary: string,
    llmCallId: string | null,
  ): void {
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO session_summaries (id, session_id, lane_key, to_seq, content, tokens, llm_call_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          newId('sessionSummary'),
          sessionId,
          laneKey,
          toSeq,
          summary,
          estimateTokens(summary),
          llmCallId,
          this.now(),
        )
      this.db
        .prepare(
          'UPDATE session_transcript SET compacted = 1 WHERE session_id = ? AND lane_key = ? AND seq <= ?',
        )
        .run(sessionId, laneKey, toSeq)
    })()
  }
}
