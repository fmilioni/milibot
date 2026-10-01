import { FakeProvider } from '@milibot/agent/testing'
import type { Message, SpendStatus, WorkspacePreferences } from '@milibot/shared'
import { afterEach, describe, expect, it } from 'vitest'

import { bootRuntime, stopRuntimes } from '../../support/runtime-harness'
import { useTempDir } from '../../support/temp'

const dir = useTempDir('spend')
afterEach(stopRuntimes)

describe('spend limits in a runtime', () => {
  it('pauses every bot at the daily spend limit and resumes on request', async () => {
    const h = await bootRuntime({
      dir: dir(),
      provider: new FakeProvider({
        script: [{ text: 'First.' }, { text: 'Second.' }],
        fallback: { text: 'ok' },
        prices: {
          priceInputPerMtokUsd: 1_000_000,
          priceOutputPerMtokUsd: 0,
          priceCacheReadPerMtokUsd: 0,
          priceCacheWritePerMtokUsd: 0,
          pricePerRequestUsd: null,
        },
      }),
      host: { compaction: false },
    })
    await h.call<WorkspacePreferences>(
      'updateWorkspacePreferences',
      {},
      { spendWarnUsd: 1, spendPauseUsd: 2 },
    )
    await h.call('postMessage', { conversationId: h.dm }, { content: 'hi' })
    await h.host.idle()
    const messages = () => h.runtime.store.messages.list(h.dm, { limit: 50 }).messages
    const cards = () => messages().filter((m: Message) => m.payload?.type === 'spend_warning')
    expect(cards()).toHaveLength(1)
    expect(cards()[0]?.payload).toMatchObject({ paused: true, limitUsd: 2, warnUsd: 1 })
    expect(await h.call<SpendStatus>('getSpendStatus')).toMatchObject({ paused: true })

    await h.call('postMessage', { conversationId: h.dm }, { content: 'again' })
    await new Promise((r) => setTimeout(r, 40))
    const texts = () =>
      messages()
        .filter((m: Message) => m.authorType === 'bot' && m.kind === 'text')
        .map((m) => m.content)
    expect(texts()).toEqual(['First.'])

    expect(await h.call<SpendStatus>('resumeSpend')).toMatchObject({ paused: false, resumed: true })
    await h.host.idle()
    expect(texts()).toEqual(['First.', 'Second.'])
  })
})
