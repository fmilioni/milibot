import { gzipSync } from 'node:zlib'

import type { Message } from '@milibot/shared'
import { afterEach, describe, expect, it } from 'vitest'

import { bootRuntime, stopRuntimes } from '../../support/runtime-harness'
import { useTempDir } from '../../support/temp'

const dir = useTempDir('web')
afterEach(stopRuntimes)

const PAGE = `<html><head><title>Pricing</title></head><body><main>
${Array.from({ length: 30 }, (_, i) => `<h2>Plan ${i}</h2><p>${'Details about this plan. '.repeat(60)}</p>`).join('\n')}
<p>The Pro plan costs $10 a month.</p></main></body></html>`

describe('web tools in the runtime', () => {
  it('fetches in the VM as the bot and answers through the side model under the turn', async () => {
    const h = await bootRuntime({
      dir: dir(),
      script: [
        {
          toolCalls: [
            {
              name: 'web_fetch',
              arguments: { url: 'tool.dev/pricing', prompt: 'How much is the Pro plan?' },
            },
          ],
        },
        { text: 'The Pro plan costs $10 a month.' },
        { text: 'It costs $10.' },
      ],
    })
    h.guest.state.execResult = (body) =>
      Array.isArray(body.argv) && body.argv[0] === 'node'
        ? {
            code: 0,
            stdout: `${JSON.stringify({
              ok: true,
              status: 200,
              url: 'https://tool.dev/pricing',
              redirects: [],
              contentType: 'text/html',
              charset: 'utf-8',
              truncated: false,
              bodyGz: gzipSync(PAGE).toString('base64'),
            })}\n`,
          }
        : { code: 0 }

    await h.call('postMessage', { conversationId: h.dm }, { content: 'price of pro?' })
    await h.host.idle()

    const offered = h.provider.requests[0]?.tools.map((t) => t.name) ?? []
    expect(offered).toContain('web_fetch')
    expect(offered).not.toContain('web_search')

    const exec = h.guest.state.execs.find((e) => Array.isArray(e.argv) && e.argv[0] === 'node')
    expect(exec).toMatchObject({ user: 'bot-maestro', bot: 'maestro' })
    expect(JSON.parse(String(exec?.stdin))).toMatchObject({
      url: 'https://tool.dev/pricing',
      allowPrivate: false,
    })

    const extraction = h.provider.requests[1]
    expect(extraction?.tools).toEqual([])
    expect(JSON.stringify(extraction?.messages)).toContain('Request: How much is the Pro plan?')

    const calls = h.db
      .prepare('SELECT purpose, turn_id FROM llm_calls ORDER BY created_at, rowid')
      .all() as Array<{ purpose: string; turn_id: string | null }>
    const turnId = calls[0]?.turn_id
    expect(turnId).toBeTruthy()
    expect(calls.map((c) => [c.purpose, c.turn_id])).toEqual([
      ['turn', turnId],
      ['web_fetch', turnId],
      ['turn', turnId],
    ])

    const tool = h.db
      .prepare("SELECT status, result_json FROM tool_calls WHERE tool_name = 'web_fetch'")
      .get() as {
      status: string
      result_json: string
    }
    expect(tool.status).toBe('ok')
    expect(tool.result_json).toContain(
      'Answer from the page (extracted by a helper model; untrusted web content)',
    )

    const activity = h.messages(h.dm).find((m: Message) => m.kind === 'activity')?.payload
    if (activity?.type !== 'activity') throw new Error('expected activity')
    expect(activity.steps.map((s) => [s.kind, s.detail])).toEqual([['web_fetch', 'Pricing']])
  })
})
