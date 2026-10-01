import { fakeGenerateImages } from '@milibot/agent/images'
import type { GeneratedImagesPayload, Provider } from '@milibot/shared'
import { afterEach, describe, expect, it } from 'vitest'

import { bootRuntime, stopRuntimes } from '../../support/runtime-harness'
import { useTempDir } from '../../support/temp'

const dir = useTempDir('images')
afterEach(stopRuntimes)

describe('image generation in the runtime', () => {
  it('offers generate_image once an image model is registered and shows the pictures in the chat', async () => {
    const h = await bootRuntime({
      dir: dir(),
      overrides: { imageGenerate: fakeGenerateImages },
      script: [
        { text: 'I have no image model.' },
        {
          toolCalls: [
            {
              name: 'generate_image',
              arguments: { prompts: ['A lighthouse at dusk, watercolor'], count: 2, aspect: '3:2' },
            },
          ],
        },
        { text: 'Here they are.' },
      ],
    })

    await h.call('postMessage', { conversationId: h.dm }, { content: 'draw a lighthouse' })
    await h.host.idle()
    expect(h.provider.requests[0]?.tools.map((t) => t.name)).not.toContain('generate_image')

    const provider = await h.call<Provider>(
      'createProvider',
      {},
      {
        type: 'openai_compatible',
        name: 'OpenRouter',
        preset: 'openrouter',
        apiKey: 'sk-or-test-key',
      },
    )
    await h.call(
      'createProviderModel',
      { providerId: provider.id },
      { kind: 'image', modelId: 'google/gemini-2.5-flash-image', pricePerRequestUsd: 0.04 },
    )

    await h.call('postMessage', { conversationId: h.dm }, { content: 'now draw it' })
    await h.host.idle()
    expect(h.provider.requests[1]?.tools.map((t) => t.name)).toContain('generate_image')

    const card = h
      .messages(h.dm)
      .map((m) => m.payload)
      .find((p): p is GeneratedImagesPayload => p?.type === 'generated_images')
    expect(card?.images.map((i) => i.status)).toEqual(['ready', 'ready'])
    expect(card?.costUsd).toBeCloseTo(0.08)
    const paths = card?.images.map((i) => i.path) ?? []
    for (const path of paths) expect(h.guest.state.files.has(path as string)).toBe(true)
    expect(paths[0]).toMatch(
      /^\/workspace\/images\/\d{4}-\d{2}-\d{2}\/a-lighthouse-at-dusk-watercolor-1\.png$/,
    )

    const purposes = (
      h.db.prepare('SELECT purpose FROM llm_calls ORDER BY created_at, rowid').all() as Array<{
        purpose: string
      }>
    ).map((r) => r.purpose)
    expect(purposes).toContain('image_generation')
  })
})
