import { describe, expect, it } from 'vitest'

import { collectHandlers, dispatch } from '../../../src/runtime/composition/routes'

describe('route sets', () => {
  it('merges route sets and refuses an endpoint served twice', () => {
    const merged = collectHandlers({ listBots: () => [] }, { listConversations: () => [] })
    expect(Object.keys(merged).sort()).toEqual(['listBots', 'listConversations'])
    expect(() => collectHandlers({ listBots: () => [] }, { listBots: () => [] })).toThrow(
      'endpoint listBots is served twice',
    )
  })

  it('answers not_found for an endpoint no set serves', () => {
    expect(() => dispatch({}, 'listBots', { workspaceId: 'ws' }, {}, undefined)).toThrow(/Unknown endpoint/)
  })
})
