import type { CompletionRequest, OpenAICompatibleProvider } from '@milibot/agent/llm'
import { MemoryBlobStore } from '@milibot/agent/testing'
import { type Bot, CLI_ENGINE_INFO } from '@milibot/shared'
import { describe, expect, it } from 'vitest'

import { effectiveContextWindow } from '../../../src/runtime/providers/catalog'
import { testProviders } from '../../support/providers'

const bot = (providerId: string): Bot => ({ id: 'bot_1', providerId, model: null }) as Bot

describe('ModelCatalog', () => {
  it("uses Claude Code's cheap alias and a provider's marked light model while it is enabled", async () => {
    const { store: providers, catalog } = testProviders()
    const claude = await providers.create({
      type: 'claude_code',
      name: 'Claude Code',
      authMode: 'subscription',
    })
    expect(await catalog.lightModelFor(await catalog.resolve(bot(claude.id)))).toMatchObject({
      kind: 'cli',
      engine: 'claude_code',
      providerId: claude.id,
      model: CLI_ENGINE_INFO.claude_code.lightModel,
    })

    const mist = await providers.create({ type: 'openai_compatible', name: 'Mist', baseUrl: 'http://x/v1' })
    providers.createModel(mist.id, { modelId: 'big', displayName: 'Big' })
    const flash = providers.createModel(mist.id, { modelId: 'flash', displayName: 'Flash' })
    const own = await catalog.resolve(bot(mist.id))
    expect(await catalog.lightModelFor(own)).toBeNull()
    await providers.update(mist.id, { lightModel: 'flash' })
    expect(await catalog.lightModelFor(own)).toMatchObject({ providerId: mist.id, model: 'flash' })
    providers.updateModel(mist.id, flash.id, { enabled: false })
    expect(await catalog.lightModelFor(own)).toBeNull()
    await providers.update(mist.id, { lightModel: 'missing' })
    expect(await catalog.lightModelFor(own)).toBeNull()
  })

  it('resolves Codex in the VM: the login there, or a key that only reaches the process environment', async () => {
    const { store: providers, clients, catalog } = testProviders()
    const sub = await providers.create({ type: 'codex', name: 'Codex', authMode: 'subscription' })
    expect(sub).toMatchObject({
      authMode: 'subscription',
      defaultModel: CLI_ENGINE_INFO.codex.defaultModel,
      idleTimeoutMinutes: 15,
    })
    expect(await catalog.resolveWith(sub.id, null, { effort: 'ultra' })).toEqual({
      kind: 'cli',
      engine: 'codex',
      providerId: sub.id,
      model: CLI_ENGINE_INFO.codex.defaultModel,
      env: {},
      config: {},
      idleTimeoutMs: 15 * 60_000,
      // `ultra` hands work to Codex's own sub-agents: never sent.
      effort: null,
      contextLimit: null,
      maxOutputTokens: null,
    })
    expect(await catalog.resolveWith(sub.id, 'gpt-6-luna', { effort: 'xhigh' })).toMatchObject({
      effort: 'xhigh',
    })
    expect(catalog.cliEngine(bot(sub.id))).toBe('codex')
    expect(providers.hasType('codex')).toBe(true)
    expect(catalog.lightModel(sub.id)).toBe(CLI_ENGINE_INFO.codex.lightModel)
    expect(catalog.catalog(bot(sub.id))[0]?.models.map((m) => m.modelId)).toContain('gpt-6-luna')
    expect(catalog.modelDisplayName(sub.id, 'gpt-6-astra')).toBe('GPT-6 Astra')

    const key = await providers.create({
      type: 'codex',
      name: 'OpenAI key',
      authMode: 'api_key',
      apiKey: 'sk-live',
    })
    const resolved = await catalog.resolve(bot(key.id))
    expect(resolved).toMatchObject({
      kind: 'cli',
      engine: 'codex',
      env: { MILIBOT_OPENAI_KEY: 'sk-live' },
      config: {
        model_provider: 'milibot',
        'model_providers.milibot': { base_url: 'https://api.openai.com/v1', env_key: 'MILIBOT_OPENAI_KEY' },
      },
    })
    expect(JSON.stringify(resolved.kind === 'cli' ? resolved.config : null)).not.toContain('sk-live')

    const gateway = await providers.create({
      type: 'codex',
      name: 'Gateway',
      authMode: 'auth_token',
      apiKey: 'tok',
      baseUrl: 'https://gw.example/v1',
    })
    expect(await catalog.resolve(bot(gateway.id))).toMatchObject({
      config: { 'model_providers.milibot': { base_url: 'https://gw.example/v1' } },
    })
    await expect(clients.client(sub.id)).rejects.toThrow(/runs inside the VM/)
  })

  it("accepts Anthropic's built-in catalog while no model is registered", async () => {
    const { store: providers, catalog } = testProviders()
    const anthropic = await providers.create({
      type: 'anthropic',
      name: 'Anthropic',
      apiKey: 'k',
      lightModel: 'claude-haiku-4-5',
    })
    expect(catalog.lightModel(anthropic.id)).toBe('claude-haiku-4-5')
    expect(catalog.modelDisplayName(anthropic.id, 'claude-haiku-4-5')).toBe('Claude Haiku 4.5')
    providers.createModel(anthropic.id, { modelId: 'claude-sonnet-5-5' })
    expect(catalog.lightModel(anthropic.id)).toBeNull()
  })
})

describe('chat model limits', () => {
  it('never runs a turn on an embedding model', async () => {
    const { store: providers, catalog } = testProviders()
    const p = await providers.create({ type: 'openai_compatible', name: 'LM Studio', baseUrl: 'http://x/v1' })
    providers.createModel(p.id, { kind: 'embedding', modelId: 'nomic-embed' })
    expect((await catalog.resolveWith(p.id, null)).kind).toBe('unavailable')
  })

  it('sends the registered output cap and reports the context window with the resolved model', async () => {
    const { store: providers, catalog } = testProviders()
    const p = await providers.create({ type: 'openai_compatible', name: 'Local', baseUrl: 'http://x/v1' })
    providers.createModel(p.id, { modelId: 'small', contextWindow: 8192, maxOutputTokens: 1024 })
    providers.createModel(p.id, { modelId: 'open' })
    const resolved = await catalog.resolveWith(p.id, 'small')
    if (resolved.kind !== 'native') throw new Error('expected a native model')
    expect(resolved.contextWindow).toBe(8192)
    const client = resolved.provider as OpenAICompatibleProvider
    const request = (model: string, maxOutputTokens?: number): CompletionRequest => ({
      model,
      messages: [],
      tools: [],
      blobs: new MemoryBlobStore(),
      ...(maxOutputTokens ? { maxOutputTokens } : {}),
    })
    expect(client.buildBody(request('small')).max_tokens).toBe(1024)
    expect(client.buildBody(request('small', 200)).max_tokens).toBe(200)
    expect(client.buildBody(request('small', 5000)).max_tokens).toBe(1024)
    expect(client.buildBody(request('open'))).not.toHaveProperty('max_tokens')
  })
})

describe('effectiveContextWindow', () => {
  it('caps the window by the limit', () => {
    expect(effectiveContextWindow(1_000_000, 256_000)).toBe(256_000)
    expect(effectiveContextWindow(128_000, 256_000)).toBe(128_000)
    expect(effectiveContextWindow(null, 256_000)).toBe(256_000)
    expect(effectiveContextWindow(200_000, null)).toBe(200_000)
    expect(effectiveContextWindow(null, null)).toBeNull()
  })
})
