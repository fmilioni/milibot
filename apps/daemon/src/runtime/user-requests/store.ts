import type { UserQuestion } from '@milibot/shared'

import type { Db } from '../../db/sqlite'
import { notFound } from '../../errors'

export type RequestKind = 'secret' | 'question'
type RequestStatus = 'pending' | 'answered' | 'answered_in_chat' | 'declined' | 'expired'

export interface UserRequestRow {
  id: string
  kind: RequestKind
  bot_id: string
  conversation_id: string
  message_id: string | null
  turn_id: string | null
  params: string
  answer: string | null
  status: RequestStatus
  created_at: number
  resolved_at: number | null
}

export interface SecretParams {
  name: string
  label: string
  reason: string
  asEnv: boolean
  replace: boolean
}

export interface QuestionParams {
  questions: UserQuestion[]
}

/** The `user_requests` rows: questions and secrets a bot asked the user for. */
export class UserRequestStore {
  constructor(
    private readonly db: Db,
    private readonly now: () => number,
  ) {}

  insert(input: {
    id: string
    kind: RequestKind
    botId: string
    conversationId: string
    turnId: string | null
    params: SecretParams | QuestionParams
  }): void {
    this.db
      .prepare(
        `INSERT INTO user_requests (id, kind, bot_id, conversation_id, turn_id, params, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`,
      )
      .run(
        input.id,
        input.kind,
        input.botId,
        input.conversationId,
        input.turnId,
        JSON.stringify(input.params),
        this.now(),
      )
  }

  setMessage(id: string, messageId: string): void {
    this.db.prepare('UPDATE user_requests SET message_id = ? WHERE id = ?').run(messageId, id)
  }

  find(id: string): UserRequestRow | null {
    return (this.db.prepare('SELECT * FROM user_requests WHERE id = ?').get(id) as UserRequestRow) ?? null
  }

  row(id: string): UserRequestRow {
    const row = this.find(id)
    if (!row) throw notFound('request', id)
    return row
  }

  pending(conversationId?: string): UserRequestRow[] {
    return (
      conversationId
        ? this.db
            .prepare("SELECT * FROM user_requests WHERE status = 'pending' AND conversation_id = ?")
            .all(conversationId)
        : this.db.prepare("SELECT * FROM user_requests WHERE status = 'pending'").all()
    ) as UserRequestRow[]
  }

  mark(id: string, status: RequestStatus, answer: unknown = null): void {
    this.db
      .prepare('UPDATE user_requests SET status = ?, answer = ?, resolved_at = ? WHERE id = ?')
      .run(status, answer === null ? null : JSON.stringify(answer), this.now(), id)
  }
}
