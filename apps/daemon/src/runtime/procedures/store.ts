import {
  newId,
  type Procedure,
  type ProcedureParameter,
  type ProcedureStatus,
  type ProcedureStepKind,
} from '@milibot/shared'

import { type Db, parseJson } from '../../db/sqlite'
import { notFound } from '../../errors'

export interface ProcedureRow {
  id: string
  bot_id: string | null
  taught_by_bot_id: string | null
  conversation_id: string | null
  name: string
  goal: string
  status: ProcedureStatus
  preconditions: string
  parameters: string
  recording: string | null
  error: string | null
  created_at: number
  updated_at: number
}

interface StepRow {
  id: string
  position: number
  kind: string
  action: string
  target: string | null
  value: string | null
  x: number | null
  y: number | null
  narration: string | null
  screenshot_hash: string | null
}

export interface NewStep {
  kind: string
  action: string
  target: string | null
  value: string | null
  x: number | null
  y: number | null
  narration: string | null
  screenshotSha: string | null
}

/** The `procedures` and `procedure_steps` tables. */
export class ProcedureStore {
  constructor(
    private readonly db: Db,
    private readonly now: () => number,
  ) {}

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)()
  }

  staleRecordings(before: number): string[] {
    return (
      this.db
        .prepare("SELECT id FROM procedures WHERE status = 'recording' AND updated_at < ?")
        .all(before) as Array<{ id: string }>
    ).map((r) => r.id)
  }

  /** A generation cut short by a restart keeps the plain recording. */
  finishInterruptedGenerations(): void {
    this.db
      .prepare("UPDATE procedures SET status = 'ready', updated_at = ? WHERE status = 'generating'")
      .run(this.now())
  }

  find(id: string): ProcedureRow | null {
    return (
      (this.db.prepare('SELECT * FROM procedures WHERE id = ?').get(id) as ProcedureRow | undefined) ?? null
    )
  }

  row(id: string): ProcedureRow {
    const row = this.find(id)
    if (!row) throw notFound('procedure', id)
    return row
  }

  toProcedure(row: ProcedureRow): Procedure {
    const steps = this.db
      .prepare('SELECT * FROM procedure_steps WHERE procedure_id = ? ORDER BY position')
      .all(row.id) as StepRow[]
    return {
      id: row.id,
      botId: row.bot_id,
      scope: row.bot_id === null ? 'global' : 'bot',
      taughtByBotId: row.taught_by_bot_id,
      name: row.name,
      goal: row.goal,
      preconditions: parseJson<string[]>(row.preconditions, []),
      parameters: parseJson<ProcedureParameter[]>(row.parameters, []),
      status: row.status,
      steps: steps.map((s) => ({
        id: s.id,
        position: s.position,
        kind: s.kind as ProcedureStepKind,
        instruction: s.action,
        target: s.target,
        value: s.value,
        x: s.x,
        y: s.y,
        narration: s.narration,
        screenshotSha: s.screenshot_hash,
      })),
      error: row.error,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  }

  /** Ready and generating procedures; with `botId`, only the ones that bot can use. */
  list(botId?: string): ProcedureRow[] {
    return (
      botId
        ? this.db
            .prepare(
              "SELECT * FROM procedures WHERE status != 'recording' AND (bot_id = ? OR bot_id IS NULL) ORDER BY name COLLATE NOCASE",
            )
            .all(botId)
        : this.db
            .prepare("SELECT * FROM procedures WHERE status != 'recording' ORDER BY name COLLATE NOCASE")
            .all()
    ) as ProcedureRow[]
  }

  insertRecording(input: { botId: string; conversationId: string | null; name: string }): string {
    const id = newId('procedure')
    const now = this.now()
    this.db
      .prepare(
        `INSERT INTO procedures (id, bot_id, taught_by_bot_id, conversation_id, name, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'recording', ?, ?)`,
      )
      .run(id, input.botId, input.botId, input.conversationId, input.name, now, now)
    return id
  }

  touch(id: string): void {
    this.db.prepare('UPDATE procedures SET updated_at = ? WHERE id = ?').run(this.now(), id)
  }

  startGeneration(id: string, input: { name: string; botId: string | null; recording: string }): void {
    this.db
      .prepare(
        `UPDATE procedures SET name = ?, bot_id = ?, goal = ?, status = 'generating', recording = ?, error = NULL, updated_at = ?
         WHERE id = ?`,
      )
      .run(input.name, input.botId, input.name, input.recording, this.now(), id)
  }

  replaceSteps(id: string, steps: NewStep[]): void {
    this.db.prepare('DELETE FROM procedure_steps WHERE procedure_id = ?').run(id)
    const insert = this.db.prepare(
      `INSERT INTO procedure_steps (id, procedure_id, position, kind, action, target, value, x, y, narration, screenshot_hash, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    const now = this.now()
    steps.forEach((step, i) =>
      insert.run(
        newId('procedureStep'),
        id,
        i + 1,
        step.kind,
        step.action,
        step.target,
        step.value,
        step.x,
        step.y,
        step.narration,
        step.screenshotSha,
        now,
      ),
    )
  }

  saveDraft(
    id: string,
    draft: { goal: string; preconditions: string[]; parameters: ProcedureParameter[] },
  ): void {
    this.db
      .prepare('UPDATE procedures SET goal = ?, preconditions = ?, parameters = ? WHERE id = ?')
      .run(draft.goal, JSON.stringify(draft.preconditions), JSON.stringify(draft.parameters), id)
  }

  markReady(id: string, error: string | null, llmCallId: string | null): void {
    this.db
      .prepare(
        "UPDATE procedures SET status = 'ready', error = ?, llm_call_id = ?, updated_at = ? WHERE id = ?",
      )
      .run(error, llmCallId, this.now(), id)
  }

  update(
    id: string,
    patch: { name: string; goal: string; botId: string | null; preconditions: string },
  ): void {
    this.db
      .prepare(
        'UPDATE procedures SET name = ?, goal = ?, bot_id = ?, preconditions = ?, updated_at = ? WHERE id = ?',
      )
      .run(patch.name, patch.goal, patch.botId, patch.preconditions, this.now(), id)
  }

  step(id: string, stepId: string): { action: string; narration: string | null } | null {
    return (
      (this.db
        .prepare('SELECT action, narration FROM procedure_steps WHERE id = ? AND procedure_id = ?')
        .get(stepId, id) as { action: string; narration: string | null } | undefined) ?? null
    )
  }

  updateStep(stepId: string, action: string, narration: string | null): void {
    this.db
      .prepare('UPDATE procedure_steps SET action = ?, narration = ? WHERE id = ?')
      .run(action, narration, stepId)
  }

  /** Deletes steps and numbers the rest from 1 again. */
  deleteSteps(id: string, stepIds: readonly string[]): void {
    const remove = this.db.prepare('DELETE FROM procedure_steps WHERE id = ? AND procedure_id = ?')
    for (const stepId of stepIds) remove.run(stepId, id)
    const ids = this.db
      .prepare('SELECT id FROM procedure_steps WHERE procedure_id = ? ORDER BY position')
      .all(id) as Array<{ id: string }>
    const move = this.db.prepare('UPDATE procedure_steps SET position = ? WHERE id = ?')
    ids.forEach((row, i) => move.run(-(i + 1), row.id))
    ids.forEach((row, i) => move.run(i + 1, row.id))
  }

  remove(id: string): void {
    this.transaction(() => {
      this.db.prepare('DELETE FROM procedure_steps WHERE procedure_id = ?').run(id)
      this.db.prepare('DELETE FROM procedures WHERE id = ?').run(id)
    })
  }

  /** Step screenshots, shown for as long as their procedure exists. */
  referencedBlobs(): string[] {
    return (
      this.db
        .prepare(
          'SELECT DISTINCT screenshot_hash AS sha FROM procedure_steps WHERE screenshot_hash IS NOT NULL',
        )
        .all() as Array<{ sha: string }>
    ).map((r) => r.sha)
  }
}
