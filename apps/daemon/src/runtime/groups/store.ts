import type { ConfirmationPayload } from '@milibot/shared'

import type { Db } from '../../db/sqlite'

export type ConfirmationAction =
  | 'remove_member'
  | 'delete_bot'
  | 'update_prompt'
  | 'continue_bot_exchange'
  | 'mcp_add'
  | 'mcp_update'
  | 'mcp_remove'
  | 'workspace_settings'

export interface ConfirmationRow {
  id: string
  bot_id: string
  conversation_id: string
  message_id: string | null
  action: ConfirmationAction
  params: string
  status: ConfirmationPayload['status']
}

/** The `confirmations` rows: destructive bot requests waiting for the user. */
export class ConfirmationStore {
  constructor(
    private readonly db: Db,
    private readonly now: () => number,
  ) {}

  insert(input: {
    id: string
    botId: string
    conversationId: string
    action: ConfirmationAction
    params: string
  }): void {
    this.db
      .prepare(
        `INSERT INTO confirmations (id, bot_id, conversation_id, action, params, status, created_at)
         VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
      )
      .run(input.id, input.botId, input.conversationId, input.action, input.params, this.now())
  }

  setMessage(id: string, messageId: string): void {
    this.db.prepare('UPDATE confirmations SET message_id = ? WHERE id = ?').run(messageId, id)
  }

  find(id: string): ConfirmationRow | null {
    return (
      (this.db.prepare('SELECT * FROM confirmations WHERE id = ?').get(id) as ConfirmationRow | undefined) ??
      null
    )
  }

  setStatus(id: string, status: ConfirmationPayload['status']): void {
    this.db
      .prepare('UPDATE confirmations SET status = ?, resolved_at = ? WHERE id = ?')
      .run(status, this.now(), id)
  }

  /** Params of `authorId`'s prompt proposals for `targetId` since `since` that were not approved. */
  promptProposalParams(authorId: string, targetId: string, since: number): string[] {
    return (
      this.db
        .prepare(
          `SELECT params FROM confirmations
           WHERE action = 'update_prompt' AND bot_id = ? AND created_at >= ?
             AND json_extract(params, '$.botId') = ? AND status != 'approved'`,
        )
        .all(authorId, since, targetId) as Array<{ params: string }>
    ).map((r) => r.params)
  }
}
