import { existsSync, mkdirSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { FakeProvider } from '@milibot/agent/testing'
import { afterEach, describe, expect, it } from 'vitest'

import { bootRuntime, stopRuntimes } from '../../support/runtime-harness'
import { useTempDir } from '../../support/temp'

const dir = useTempDir('retention')
afterEach(stopRuntimes)

describe('debug retention', () => {
  it('purges payloads and screenshots older than the retention', async () => {
    const h = await bootRuntime({
      dir: dir(),
      provider: new FakeProvider({ script: [{ text: 'ok' }], fallback: { text: 'ok' } }),
      host: { compaction: false },
    })
    await h.call('postMessage', { conversationId: h.dm }, { content: 'hi' })
    await h.host.idle()
    const db = h.runtime.store.db
    db.prepare('UPDATE llm_calls SET created_at = ?').run(Date.now() - 40 * 24 * 60 * 60 * 1000)
    const blobDir = join(dir(), 'debug', 'blobs', 'ab')
    mkdirSync(blobDir, { recursive: true })
    const old = join(blobDir, `${'ab'.padEnd(64, '0')}.png`)
    const fresh = join(blobDir, `${'ab'.padEnd(64, '1')}.png`)
    const taughtSha = 'ab'.padEnd(64, '2')
    const taught = join(blobDir, `${taughtSha}.png`)
    writeFileSync(old, 'x'.repeat(100))
    writeFileSync(fresh, 'y'.repeat(50))
    writeFileSync(taught, 'z'.repeat(10))
    const past = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000)
    utimesSync(old, past, past)
    utimesSync(taught, past, past)
    const now = Date.now()
    db.prepare(
      "INSERT INTO procedures (id, name, status, created_at, updated_at) VALUES ('prc_t', 'T', 'ready', ?, ?)",
    ).run(now, now)
    db.prepare(
      "INSERT INTO procedure_steps (id, procedure_id, position, action, screenshot_hash, created_at) VALUES ('prs_t', 'prc_t', 0, 'click', ?, ?)",
    ).run(taughtSha, now)

    const before = await h.call<{ blobsBytes: number; payloadBytes: number }>('getDebugStorage')
    expect(before.blobsBytes).toBe(160)
    expect(before.payloadBytes).toBeGreaterThan(0)
    const result = await h.call<{
      payloadsCleared: number
      blobsRemoved: number
      storage: { payloadBytes: number }
    }>('purgeDebugData')
    expect(result).toMatchObject({ blobsRemoved: 1, storage: { payloadBytes: 0 } })
    expect(result.payloadsCleared).toBeGreaterThan(0)
    expect(existsSync(old)).toBe(false)
    expect(existsSync(fresh)).toBe(true)
    expect(existsSync(taught)).toBe(true)
    const row = db.prepare('SELECT cost_usd, input_tokens FROM llm_calls').get() as { input_tokens: number }
    expect(row.input_tokens).toBeGreaterThan(0)
  })
})
