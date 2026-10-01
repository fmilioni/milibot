import { ApiError, CLI_ENGINES } from '@milibot/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { startSupervisor, type SupervisorHarness } from '../support/supervisor-harness'
import { removeDir, tempDir } from '../support/temp'

let dataRoot: string
let harness: SupervisorHarness
let workspaceId: string

beforeAll(async () => {
  dataRoot = tempDir('cli-routes')
  harness = await startSupervisor({ dataRoot })
  workspaceId = (await harness.client.call('createWorkspace', { body: { name: 'Engines', color: 'blue' } }))
    .id
})

afterAll(async () => {
  await harness?.close()
  if (dataRoot) removeDir(dataRoot)
})

describe('CLI engine routes', () => {
  it('serves every engine through the same routes', async () => {
    for (const engine of CLI_ENGINES) {
      const params = { workspaceId, engine }
      expect(await harness.client.call('getCliLoginStatus', { params })).toEqual({
        loggedIn: null,
        terminalOpen: null,
        loggedInElsewhere: false,
      })
      const updated = await harness.client.call('updateCliSettings', {
        params,
        body: { rotateIdleMinutes: 20 },
      })
      expect(updated.rotateIdleMinutes).toBe(20)
      expect((await harness.client.call('getCliSettings', { params })).rotateIdleMinutes).toBe(20)
    }
  })

  it('answers `unsupported` for a capability the engine lacks', async () => {
    const error = await harness.client
      .call('getCliInstall', { params: { workspaceId, engine: 'claude_code' } })
      .catch((err: unknown) => err)
    expect(error).toBeInstanceOf(ApiError)
    expect(error).toMatchObject({ code: 'unsupported', status: 400 })
  })

  it('refuses an engine that does not exist', async () => {
    const response = await fetch(`${harness.baseUrl}/w/${workspaceId}/cli/gemini/settings`, {
      headers: { authorization: `Bearer ${harness.supervisor.token}` },
    })
    expect(response.status).toBe(400)
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe('validation_failed')
  })
})
