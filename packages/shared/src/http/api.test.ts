import { describe, expect, it } from 'vitest'

import { api } from './api'
import { buildPath } from './path'

describe('api', () => {
  it('serves every workspace route under /w/:workspaceId', () => {
    expect(api.listBots.scope).toBe('workspace')
    expect(api.listWorkspaces.scope).toBe('app')
    for (const def of Object.values(api)) {
      expect(def.scope === 'workspace').toBe(def.path.startsWith('/w/:workspaceId/'))
    }
  })

  it('builds paths with encoded params', () => {
    expect(buildPath(api.updateBot.path, { workspaceId: 'ws_1', botId: 'a/b' })).toBe('/w/ws_1/bots/a%2Fb')
    expect(() => buildPath(api.updateBot.path, { workspaceId: 'ws_1' })).toThrow(/botId/)
  })

  it('validates requests with the declared schemas', () => {
    expect(api.createWorkspace.body.parse({ name: '  Acme ', color: 'violet' })).toEqual({
      name: 'Acme',
      color: 'violet',
    })
    expect(api.createWorkspace.body.safeParse({ name: '', color: 'violet' }).success).toBe(false)
    expect(api.createWorkspace.body.safeParse({ name: 'X', color: 'purple' }).success).toBe(false)
    expect(
      api.createWorkspace.body.parse({
        name: 'Acme',
        color: 'teal',
        setup: true,
        copyFrom: { workspaceId: 'ws_1', providers: true },
      }).copyFrom,
    ).toEqual({ workspaceId: 'ws_1', providers: true, keys: false, vmSize: false })
    expect(api.createBot.body.parse({ name: 'Dex' })).toEqual({ name: 'Dex', label: '', systemPrompt: '' })
    expect(api.listMessages.query.parse({ limit: '20' })).toEqual({ limit: 20 })
    expect(api.listMessages.query.parse({})).toEqual({ limit: 50 })
    expect(api.listMessages.query.safeParse({ limit: '500' }).success).toBe(false)
  })
})
