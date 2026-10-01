import { describe, expect, it } from 'vitest'

import { openRouterAccount } from '../../../src/runtime/providers/handlers'

describe('openRouterAccount', () => {
  it('reads OpenRouter credit from /credits, else from the key limit', async () => {
    const credits = (async (url: string) =>
      String(url).endsWith('/credits')
        ? new Response(JSON.stringify({ data: { total_credits: 25, total_usage: 6.6 } }))
        : new Response('{}', { status: 500 })) as typeof fetch
    expect(await openRouterAccount(credits, 'k')).toMatchObject({ creditUsd: 25 - 6.6, usageUsd: 6.6 })
    const keyOnly = (async (url: string) =>
      String(url).endsWith('/credits')
        ? new Response('{}', { status: 403 })
        : new Response(JSON.stringify({ data: { usage: 2, limit: 10, limit_remaining: 8 } }))) as typeof fetch
    expect(await openRouterAccount(keyOnly, 'k')).toMatchObject({ creditUsd: 8, limitUsd: 10, usageUsd: 2 })
  })
})
