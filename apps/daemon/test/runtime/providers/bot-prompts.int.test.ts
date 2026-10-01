import type { CompletionRequest } from '@milibot/agent/llm'
import type { BotPromptDraft } from '@milibot/shared'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { bootRuntime, type RuntimeHarness, stopRuntimes } from '../../support/runtime-harness'
import { useTempDir } from '../../support/temp'

let h: RuntimeHarness
const requests: CompletionRequest[] = []
const dir = useTempDir('bot-prompt')
afterEach(stopRuntimes)

beforeEach(async () => {
  requests.length = 0
  h = await bootRuntime({
    dir: dir(),
    vm: false,
    script: (request) => {
      requests.push(request)
      return { text: "<system_prompt>\n# Nina\nYou run the store's Instagram.\n</system_prompt>" }
    },
  })
})

describe('generateBotPrompt', () => {
  it('writes a persona from the description on behalf of the first bot and logs the call', async () => {
    const draft = await h.call<BotPromptDraft>(
      'generateBotPrompt',
      {},
      { name: 'Nina', label: 'Social media', description: "Runs the store's Instagram", language: 'pt-BR' },
    )
    expect(draft.systemPrompt).toBe("# Nina\nYou run the store's Instagram.")
    expect(draft.maxTokens).toBe(1500)
    expect(draft.tokens).toBeGreaterThan(0)
    expect(requests).toHaveLength(1)
    const system = requests[0]?.messages[0]
    expect(system?.role).toBe('system')
    expect(JSON.stringify(system)).toContain('Brazilian Portuguese')
    expect(requests[0]?.tools).toEqual([])
    const logged = h.store.db
      .prepare("SELECT purpose, bot_id AS botId FROM llm_calls WHERE purpose = 'bot_prompt'")
      .all()
    expect(logged).toEqual([{ purpose: 'bot_prompt', botId: h.store.bots.first()?.id }])
  })

  it('refuses an empty description', async () => {
    await expect(
      h.call('generateBotPrompt', {}, { name: 'Nina', label: '', description: '   ', language: 'pt-BR' }),
    ).rejects.toThrow(/Invalid request/)
  })
})
