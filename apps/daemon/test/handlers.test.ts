import { describe, expect, it } from 'vitest'

import { DaemonError } from '../src/errors'
import { parseEndpointInput } from '../src/handlers'

describe('endpoint input', () => {
  const params = { workspaceId: 'ws_1' }

  it('validates the query and body an endpoint declares', () => {
    expect(parseEndpointInput('updateConversation', params, undefined, { title: 'Launch' })).toEqual({
      params,
      query: undefined,
      body: { title: 'Launch' },
    })
    expect(() => parseEndpointInput('updateConversation', params, undefined, { title: 3 })).toThrow(
      DaemonError,
    )
    expect(parseEndpointInput('getWorkspaceStatus', params, { ignored: '1' }, { ignored: true })).toEqual({
      params,
      query: undefined,
      body: undefined,
    })
  })

  it('validates the path params an endpoint narrows', () => {
    expect(parseEndpointInput('getCliInstall', { ...params, engine: 'codex' }, undefined, undefined)).toEqual(
      {
        params: { workspaceId: 'ws_1', engine: 'codex' },
        query: undefined,
        body: undefined,
      },
    )
    expect(() =>
      parseEndpointInput('getCliInstall', { ...params, engine: 'gemini' }, undefined, undefined),
    ).toThrow(DaemonError)
  })
})
