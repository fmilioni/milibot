import { describe, expect, it } from 'vitest'

import { api } from '../http/api'
import { CLI_ENGINE_INFO, CLI_ENGINES, cliErrorOf, cliModelInfo } from './cli'
import { ProviderType } from './providers'

describe('CLI engine info', () => {
  it('describes every engine, each a provider type whose default and light models are in its catalog', () => {
    for (const engine of CLI_ENGINES) {
      const info = CLI_ENGINE_INFO[engine]
      expect(ProviderType.options).toContain(engine)
      expect(cliModelInfo(engine, null)?.id).toBe(info.defaultModel)
      expect(cliModelInfo(engine, info.lightModel)).not.toBeNull()
      expect(info.authModes).toContain('subscription')
    }
  })

  it("finds a model of the engine's catalog, ignoring Claude Code's 1M suffix", () => {
    expect(cliModelInfo('claude_code', 'opus[1m]')?.contextWindow).toBe(1_000_000)
    expect(cliModelInfo('codex', 'gpt-6-luna')).toMatchObject({ input: 0.1, output: 0.5 })
    expect(cliModelInfo('codex', 'opus')).toBeNull()
  })
})

describe('cliErrorOf', () => {
  it('reads the generic codes with their engine', () => {
    expect(cliErrorOf('cli_usage_limit', { engine: 'codex' })).toEqual({
      code: 'cli_usage_limit',
      engine: 'codex',
    })
    expect(cliErrorOf('cli_error', { engine: 'gemini' })).toBeNull()
    expect(cliErrorOf('cli_error')).toBeNull()
    expect(cliErrorOf('provider_error', { engine: 'codex' })).toBeNull()
  })
})

describe('CLI engine endpoints', () => {
  it('serves every engine under one path, validating the engine', () => {
    expect(api.getCliInstall.path).toBe('/w/:workspaceId/cli/:engine/install')
    expect(api.getCliInstall.params.parse({ engine: 'codex' })).toEqual({ engine: 'codex' })
    expect(api.getCliInstall.params.safeParse({ engine: 'gemini' }).success).toBe(false)
    expect(api.updateCliSettings.body.parse({ rotateIdleMinutes: 30 })).toEqual({ rotateIdleMinutes: 30 })
    expect(api.updateCliSettings.body.safeParse({ rotateContextTokens: 5 }).success).toBe(false)
  })
})
