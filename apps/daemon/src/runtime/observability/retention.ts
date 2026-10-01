import { readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'

import {
  type DebugStorage,
  DEFAULT_WORKSPACE_PREFERENCES,
  type LogFn,
  PREFERENCE_SETTING_KEYS,
} from '@milibot/shared'

import type { Db } from '../../db/sqlite'
import { errorMessage } from '../../errors'

const DAY_MS = 24 * 60 * 60 * 1000

/** Blobs other domains still show (attachments, procedure steps, designs, board images, generated pictures). */
export class BlobReferences {
  private readonly sources = new Map<string, () => Iterable<string>>()

  register(name: string, shas: () => Iterable<string>): void {
    if (this.sources.has(name)) throw new Error(`blob references of ${name} are registered twice`)
    this.sources.set(name, shas)
  }

  collect(into = new Set<string>()): Set<string> {
    for (const shas of this.sources.values()) for (const sha of shas()) into.add(sha)
    return into
  }
}

export interface DebugRetentionDeps {
  db: Db
  references: BlobReferences
  /** `<wsDir>/debug` */
  debugDir: string
  getSetting<T>(key: string, fallback: T): T
  now: () => number
  log?: LogFn
}

const days = (value: unknown, fallback: number) =>
  typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : fallback

async function walk(dir: string, visit: (file: string, size: number, mtimeMs: number) => Promise<void>) {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) await walk(path, visit)
    else if (entry.isFile()) {
      const info = await stat(path).catch(() => null)
      if (info) await visit(path, info.size, info.mtimeMs)
    }
  }
}

/**
 * Debug history retention: raw LLM/tool payloads and screenshots are kept for N days (settings);
 * tokens and costs stay forever. Blobs are content-addressed, so a blob is removed only when older
 * than the screenshot retention and not referenced by a tool call inside it.
 */
export class DebugRetention {
  private timer: NodeJS.Timeout | null = null

  constructor(private readonly deps: DebugRetentionDeps) {}

  /** Purges now and then once a day. */
  start(): void {
    const purge = () =>
      void this.purge()
        .then((r) => {
          if (r.payloadsCleared || r.blobsRemoved) this.deps.log?.('info', 'debug history purged', r)
        })
        .catch((err: unknown) => this.deps.log?.('warn', 'debug purge failed', { err: errorMessage(err) }))
    purge()
    this.timer = setInterval(purge, DAY_MS)
    this.timer.unref()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  private windows(): { payloadCutoff: number; screenshotCutoff: number } {
    const get = this.deps.getSetting.bind(this.deps)
    const now = this.deps.now()
    const payloadDays = days(
      get<unknown>(PREFERENCE_SETTING_KEYS.payloadRetentionDays, null),
      DEFAULT_WORKSPACE_PREFERENCES.payloadRetentionDays,
    )
    const screenshotDays = days(
      get<unknown>(PREFERENCE_SETTING_KEYS.screenshotRetentionDays, null),
      DEFAULT_WORKSPACE_PREFERENCES.screenshotRetentionDays,
    )
    return { payloadCutoff: now - payloadDays * DAY_MS, screenshotCutoff: now - screenshotDays * DAY_MS }
  }

  async storage(): Promise<DebugStorage> {
    let blobsBytes = 0
    await walk(join(this.deps.debugDir, 'blobs'), async (_file, size) => {
      blobsBytes += size
    })
    const row = this.deps.db
      .prepare(
        `SELECT
           (SELECT COALESCE(SUM(LENGTH(request_json) + LENGTH(response_json)), 0) FROM llm_calls) +
           (SELECT COALESCE(SUM(LENGTH(arguments_json) + LENGTH(result_json)), 0) FROM tool_calls) AS bytes`,
      )
      .get() as { bytes: number | null }
    const payloadBytes = row.bytes ?? 0
    return { path: this.deps.debugDir, blobsBytes, payloadBytes, totalBytes: blobsBytes + payloadBytes }
  }

  async purge(): Promise<{ payloadsCleared: number; blobsRemoved: number }> {
    const { payloadCutoff, screenshotCutoff } = this.windows()
    const { db } = this.deps
    const now = this.deps.now()
    const clear = db.transaction(() => {
      const llm = db
        .prepare(
          `UPDATE llm_calls SET request_json = NULL, response_json = NULL, payload_purged_at = ?
           WHERE created_at < ? AND (request_json IS NOT NULL OR response_json IS NOT NULL)`,
        )
        .run(now, payloadCutoff).changes
      const tools = db
        .prepare(
          `UPDATE tool_calls SET arguments_json = NULL, result_json = NULL, payload_purged_at = ?
           WHERE started_at < ? AND (arguments_json IS NOT NULL OR result_json IS NOT NULL)`,
        )
        .run(now, payloadCutoff).changes
      return llm + tools
    })
    const payloadsCleared = clear()
    const recent = new Set(
      (
        db
          .prepare(
            'SELECT DISTINCT screenshot_hash AS sha FROM tool_calls WHERE screenshot_hash IS NOT NULL AND started_at >= ?',
          )
          .all(screenshotCutoff) as Array<{ sha: string }>
      ).map((r) => r.sha),
    )
    this.deps.references.collect(recent)
    let blobsRemoved = 0
    await walk(join(this.deps.debugDir, 'blobs'), async (file, _size, mtimeMs) => {
      if (mtimeMs >= screenshotCutoff) return
      const sha = /([0-9a-f]{64})\.\w+$/.exec(file)?.[1]
      if (!sha || recent.has(sha)) return
      await rm(file, { force: true })
      blobsRemoved++
    })
    return { payloadsCleared, blobsRemoved }
  }
}
