import { describe, expect, it } from 'vitest'

import { solidPng } from '../media/png'
import { FakeCodexBackend } from '../test-support/codex'
import { makeBot } from '../test-support/env'
import { codexGenerateImages, type CodexImageRequest } from './images'

const bot = makeBot({ slug: 'iris' })
const png = Buffer.from(solidPng(2, 2, [255, 0, 0])).toString('base64')

const request = (extra: Partial<CodexImageRequest> = {}): CodexImageRequest => ({
  bot,
  model: 'gpt-6-luna',
  env: {},
  providerConfig: {},
  prompt: 'a red square',
  count: 1,
  aspect: '16:9',
  transparent: true,
  referencePaths: ['/workspace/ref.png'],
  ...extra,
})

const imageItem = (id: string, result: string, failure: unknown = null) => ({
  method: 'item/completed',
  params: {
    threadId: 't',
    turnId: 'x',
    item: { type: 'imageGeneration', id, status: 'completed', revisedPrompt: 'red', result, failure },
  },
})
const completed = (status = 'completed', error: unknown = null) => ({
  method: 'turn/completed',
  params: { threadId: 't', turn: { id: 'x', status, error, durationMs: 10 } },
})

describe('codexGenerateImages', () => {
  it('draws in an ephemeral thread with the image tool on and returns the pictures', async () => {
    const backend = new FakeCodexBackend()
    backend.turnScripts = [[imageItem('ig_1', png), completed()]]
    const result = await codexGenerateImages(backend, request())
    expect(result.images).toHaveLength(1)
    expect(result.images[0]?.mediaType).toBe('image/png')
    expect(result.costUsd).toBeNull()
    const start = backend.requests.find((r) => r.method === 'thread/start')
    expect(start?.params).toMatchObject({ ephemeral: true, model: 'gpt-6-luna' })
    expect(start?.params.config).toMatchObject({
      'features.image_generation': true,
      'features.shell_tool': false,
    })
    expect(String(start?.params.developerInstructions)).toContain('wide (16:9). Transparent background.')
    const turn = backend.requests.find((r) => r.method === 'turn/start')
    expect(turn?.params.input).toEqual([
      { type: 'text', text: 'a red square', text_elements: [] },
      { type: 'localImage', path: '/workspace/ref.png' },
    ])
    expect(backend.specs[0]?.label).toBe('codex-image:iris')
  })

  it('reports a used-up quota, and a turn that drew nothing', async () => {
    const quota = new FakeCodexBackend()
    quota.turnScripts = [
      [imageItem('ig_1', '', { type: 'usageLimitExceeded', limitId: 'images', resetsAt: null }), completed()],
    ]
    await expect(codexGenerateImages(quota, request())).rejects.toMatchObject({ code: 'quota' })

    const nothing = new FakeCodexBackend()
    nothing.turnScripts = [[completed()]]
    await expect(codexGenerateImages(nothing, request())).rejects.toMatchObject({ code: 'no_image' })

    const failed = new FakeCodexBackend()
    failed.turnScripts = [[completed('failed', { message: 'boom', codexErrorInfo: 'other' })]]
    await expect(codexGenerateImages(failed, request())).rejects.toMatchObject({ code: 'provider_error' })
  })
})
