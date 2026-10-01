import { describe, expect, it } from 'vitest'

import { FakeProvider } from './fake'
import { complete, type CompletionRequest } from './provider'

function request(system: string): CompletionRequest {
  return {
    model: 'fake-model',
    messages: [
      { role: 'system', content: [{ type: 'text', text: system }] },
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    ],
    tools: [],
  } as unknown as CompletionRequest
}

describe('FakeProvider', () => {
  it('gives a `when` step only to the request whose system prompt names it, in any order', async () => {
    const provider = new FakeProvider({
      script: [{ text: 'turn 1' }, { when: 'You draw', text: '<svg/>' }, { text: 'turn 2' }],
    })
    const text = async (system: string) => (await complete(provider, request(system))).message.content
    expect(await text('bot rules')).toEqual([{ type: 'text', text: 'turn 1' }])
    expect(await text('bot rules')).toEqual([{ type: 'text', text: 'turn 2' }])
    expect(await text('You draw vector art.')).toEqual([{ type: 'text', text: '<svg/>' }])
    expect(await text('bot rules')).toEqual([{ type: 'text', text: 'Done.' }])
  })

  it('streams the text to onText', async () => {
    const provider = new FakeProvider({ script: [{ text: 'a'.repeat(30), pieceDelayMs: 1 }] })
    const pieces: string[] = []
    await complete(provider, request('x'), (d) => pieces.push(d))
    expect(pieces).toEqual(['a'.repeat(12), 'a'.repeat(12), 'a'.repeat(6)])
  })
})
