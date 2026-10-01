import type { LlmCallRecord, ToolResult } from '@milibot/agent'
import { fakeGenerateImages, type ImageGenerate, ImageGenerationError } from '@milibot/agent/images'
import { solidPng } from '@milibot/agent/testing'
import type { Bot, GeneratedImagesPayload } from '@milibot/shared'
import { beforeEach, describe, expect, it } from 'vitest'

import { ImageService } from '../../../src/runtime/images/service'
import { ImageTools } from '../../../src/runtime/images/tools'
import { ProviderStore } from '../../../src/runtime/providers/store'
import { GuestClient, GuestError } from '../../../src/runtime/vm/guest-client'
import { WorkspaceStore } from '../../../src/runtime/workspace-store'
import { MemorySecretStore } from '../../../src/secrets/secret-store'
import { localDay } from '../../../src/util/time'
import { openWorkspaceDb } from '../../../src/workspace-db/open'

function memoryGuest() {
  const files = new Map<string, Buffer>()
  const owners = new Map<string, string | undefined>()
  const guest = {
    async fsWriteChunk(path: string, base64: string, options: { append: boolean; owner?: string }) {
      const bytes = Buffer.from(base64, 'base64')
      files.set(path, options.append ? Buffer.concat([files.get(path) ?? Buffer.alloc(0), bytes]) : bytes)
      owners.set(path, options.owner)
      return { path, size: files.get(path)?.length ?? 0 }
    },
    async fsRead(path: string) {
      const file = files.get(path)
      if (!file) throw new GuestError('path_not_found', `no such path: ${path}`, 404)
      return { path, size: file.length, content: '', truncated: true }
    },
    async fsReadChunk(path: string, offset: number, maxBytes: number) {
      const file = files.get(path)
      if (!file) throw new GuestError('path_not_found', `no such path: ${path}`, 404)
      const part = file.subarray(offset, offset + maxBytes)
      return {
        path,
        size: file.length,
        content: part.toString('base64'),
        truncated: offset + part.length < file.length,
      }
    },
    fsWriteAll: GuestClient.prototype.fsWriteAll,
    fsReadAll: GuestClient.prototype.fsReadAll,
  }
  return { files, owners, guest: guest as unknown as GuestClient }
}

describe('ImageService (generate_image)', () => {
  let store: WorkspaceStore
  let providers: ProviderStore
  let vmFs: ReturnType<typeof memoryGuest>
  let running: boolean
  let calls: LlmCallRecord[]
  let blobs: Map<string, Uint8Array>
  let generate: ImageGenerate
  let service: ImageService
  let nina: Bot
  let dm: string
  let providerId: string
  let codexJobs: Array<{ providerId: string; prompt: string; referencePaths: string[] }>

  beforeEach(async () => {
    const db = openWorkspaceDb(':memory:')
    store = new WorkspaceStore(db, () => Date.now())
    providers = new ProviderStore({ db, workspaceId: 'ws', secrets: new MemorySecretStore() })
    nina = store.bots.create({ name: 'Nina', label: 'Design', systemPrompt: '' })
    dm = store.conversations.create({ type: 'direct', botIds: [nina.id] }).id
    vmFs = memoryGuest()
    running = true
    calls = []
    blobs = new Map()
    generate = fakeGenerateImages
    codexJobs = []
    providerId = (
      await providers.create({
        type: 'openai_compatible',
        name: 'OpenRouter',
        preset: 'openrouter',
        apiKey: 'sk-or',
      })
    ).id
    service = new ImageService({
      providers,
      preference: () => null,
      vm: {
        status: () => ({ state: running ? 'running' : 'stopped', desktops: 0 }) as never,
        runningGuest: () => vmFs.guest,
      },
      blobs: {
        put: async (bytes) => {
          const sha = `${blobs.size}`.padStart(64, '0')
          blobs.set(sha, bytes)
          return sha
        },
      },
      cardConversation: (bot, conversationId) => store.conversations.forCard(bot, conversationId),
      appendMessage: (message) => store.messages.create(message),
      updateMessage: (id, patch) => {
        store.messages.update(id, patch)
        return store.messages.get(id)
      },
      recordLlmCall: (record) => {
        calls.push(record)
        return `llm_${calls.length}`
      },
      generate: (server, request) => generate(server, request),
      cliImages: async (_bot, codexProviderId, _engine, job) => {
        codexJobs.push({
          providerId: codexProviderId,
          prompt: job.prompt,
          referencePaths: job.referencePaths,
        })
        return { images: [{ bytes: solidPng(8, 8, [0, 0, 255]), mediaType: 'image/png' }], costUsd: null }
      },
      now: () => Date.now(),
      log: () => {},
    })
  })

  const addModel = (modelId: string, patch: { pricePerRequestUsd?: number | null; enabled?: boolean } = {}) =>
    providers.createModel(providerId, { kind: 'image', modelId, supportsTools: false, ...patch })

  const run = (args: Record<string, unknown>): Promise<ToolResult> =>
    new ImageTools({ images: service }).execute(
      { bot: nina, conversationId: dm, turnId: 'turn_1', signal: new AbortController().signal } as never,
      { id: 'call_1', name: 'generate_image', arguments: args },
    )

  const text = (result: ToolResult) =>
    result.content.flatMap((p) => (p.type === 'text' ? [p.text] : [])).join('\n')
  const card = () =>
    store.messages
      .list(dm, { limit: 50 })
      .messages.map((m) => m.payload)
      .find((p): p is GeneratedImagesPayload => p?.type === 'generated_images')

  it("draws with a Codex provider's ChatGPT subscription, only while it signs in that way", async () => {
    const codex = await providers.create({ type: 'codex', name: 'Codex', authMode: 'subscription' })
    expect(service.available()).toBe(true)
    const result = await run({ prompts: ['A fox at dawn'], name: 'Fox' })
    expect(result.isError).toBeFalsy()
    expect(codexJobs).toEqual([{ providerId: codex.id, prompt: 'A fox at dawn', referencePaths: [] }])
    expect(calls[0]).toMatchObject({
      providerType: 'codex',
      model: 'codex-image',
      purpose: 'image_generation',
    })
    expect(card()?.images.map((i) => i.status)).toEqual(['ready'])
    await providers.update(codex.id, { authMode: 'api_key', apiKey: 'sk' })
    expect(service.available()).toBe(false)
  })

  it('is available only while an image model is enabled', () => {
    expect(service.available()).toBe(false)
    const model = addModel('google/gemini-2.5-flash-image')
    expect(service.available()).toBe(true)
    providers.updateModel(providerId, model.id, { enabled: false })
    expect(service.available()).toBe(false)
  })

  it('saves every picture in the VM, shows them in a card and records the cost per call', async () => {
    addModel('google/gemini-2.5-flash-image', { pricePerRequestUsd: 0.04 })
    const result = await run({
      prompts: ['A fox at dawn', 'A fox at night'],
      count: 2,
      aspect: '16:9',
      name: 'Fox',
    })

    expect(result.isError).toBeFalsy()
    const day = `/workspace/images/${localDay(Date.now())}`
    expect([...vmFs.files.keys()].sort()).toEqual([1, 2, 3, 4].map((n) => `${day}/fox-${n}.png`))
    expect(vmFs.owners.get(`${day}/fox-1.png`)).toBe(`bot-${nina.slug}`)
    expect(text(result)).toContain('Generated 4 of 4 pictures')
    expect(text(result)).toContain('shown to the user in the chat')
    expect(result.content.filter((p) => p.type === 'image')).toHaveLength(4)

    const payload = card()
    expect(payload?.images.map((i) => i.status)).toEqual(['ready', 'ready', 'ready', 'ready'])
    expect(payload?.images.map((i) => i.promptIndex)).toEqual([0, 0, 1, 1])
    expect(payload?.images.every((i) => i.sha && i.width === 96 && i.height === 54)).toBe(true)
    expect(payload?.costUsd).toBeCloseTo(0.16)

    expect(calls).toHaveLength(2)
    expect(calls[0]).toMatchObject({
      purpose: 'image_generation',
      botId: nina.id,
      turnId: 'turn_1',
      model: 'google/gemini-2.5-flash-image',
      usage: { costSource: 'computed' },
    })
    expect(calls[0]?.usage.costUsd).toBeCloseTo(0.08)
  })

  it('keeps the pictures that worked when one prompt fails', async () => {
    addModel('google/gemini-2.5-flash-image')
    generate = async (server, request) => {
      if (request.prompt.includes('bad')) throw new ImageGenerationError('no_image', 'the prompt was blocked')
      return fakeGenerateImages(server, request)
    }
    const result = await run({ prompts: ['good', 'bad'] })
    expect(result.isError).toBeFalsy()
    expect(text(result)).toContain('Generated 1 of 2 pictures')
    expect(text(result)).toContain('prompt 2: the prompt was blocked')
    expect(card()?.images.map((i) => i.status)).toEqual(['ready', 'failed'])
    expect(calls.map((c) => c.error)).toEqual(expect.arrayContaining([null, 'the prompt was blocked']))
  })

  it('fails as a whole only when no picture came out', async () => {
    addModel('google/gemini-2.5-flash-image')
    generate = async () => {
      throw new ImageGenerationError('provider_error', 'HTTP 402: no credit', 402)
    }
    const result = await run({ prompts: ['a fox'] })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('HTTP 402: no credit')
    expect(card()?.images.map((i) => i.status)).toEqual(['failed'])
  })

  it('tells the bot not to wait when the account has no quota, and shows why in the card', async () => {
    addModel('gemini-2.5-flash-image')
    generate = async () => {
      throw new ImageGenerationError('quota', 'HTTP 429: You exceeded your current quota', 429)
    }
    const result = await run({ prompts: ['a fox'] })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('Waiting or retrying will not help')
    expect(card()?.images).toEqual([expect.objectContaining({ status: 'failed', failure: 'quota' })])
  })

  it("doesn't post a card for design assets and never overwrites a picture", async () => {
    addModel('google/gemini-2.5-flash-image')
    await run({ prompts: ['hero'], name: 'hero', share: false })
    await run({ prompts: ['hero'], name: 'hero', share: false })
    expect(card()).toBeUndefined()
    const day = `/workspace/images/${localDay(Date.now())}`
    expect([...vmFs.files.keys()].sort()).toEqual([`${day}/hero-1.png`, `${day}/hero-2.png`])
  })

  it('refuses what the model cannot do before generating anything', async () => {
    addModel('google/gemini-2.5-flash-image')
    const result = await run({ prompts: ['a sticker'], transparent: true })
    expect(result.isError).toBe(true)
    expect(text(result)).toMatch(/transparent/)
    expect(calls).toHaveLength(0)
    expect(card()).toBeUndefined()
  })

  it('picks the model the bot names, and lists the available ones when it is unknown', async () => {
    addModel('google/gemini-2.5-flash-image')
    addModel('openai/gpt-5-image')
    await run({ prompts: ['a fox'], model: 'gpt-5-image' })
    expect(calls[0]?.model).toBe('openai/gpt-5-image')
    const result = await run({ prompts: ['a fox'], model: 'midjourney' })
    expect(text(result)).toContain('Available: google/gemini-2.5-flash-image, openai/gpt-5-image')
  })

  it('rejects more than four pictures per call and missing models or VM', async () => {
    expect(text(await run({ prompts: ['a fox'] }))).toContain('No image model is set up')
    addModel('google/gemini-2.5-flash-image')
    expect(text(await run({ prompts: ['a', 'b', 'c'], count: 2 }))).toContain('At most 4 pictures per call')
    running = false
    expect(text(await run({ prompts: ['a fox'] }))).toContain('The VM is not running')
  })

  it('reads reference images from the VM and refuses files that are not images', async () => {
    addModel('google/gemini-2.5-flash-image')
    let seen = 0
    generate = async (server, request) => {
      seen = request.references.length
      return fakeGenerateImages(server, request)
    }
    const png = (
      await fakeGenerateImages(
        { baseUrl: '', apiKey: null, preset: null },
        {
          model: 'x',
          prompt: 'ref',
          count: 1,
          aspect: '1:1',
          transparent: false,
          references: [],
        },
      )
    ).images[0]!.bytes
    vmFs.files.set('/workspace/uploads/photo.png', Buffer.from(png))
    vmFs.files.set('/workspace/notes.txt', Buffer.from('hello'))
    await run({ prompts: ['restyle it'], references: ['/workspace/uploads/photo.png'] })
    expect(seen).toBe(1)
    expect(text(await run({ prompts: ['x'], references: ['/workspace/notes.txt'] }))).toContain(
      'not a PNG, JPEG or WebP',
    )
    expect(text(await run({ prompts: ['x'], references: ['/etc/passwd'] }))).toContain('under /workspace')
  })
})
