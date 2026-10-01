import { estimateTokens, PERSONA_MAX_TOKENS } from '@milibot/shared'
import { describe, expect, it } from 'vitest'

import {
  type BotPromptRequest,
  botPromptRequest,
  botPromptSystem,
  fitPersona,
  generateBotPrompt,
  parseGeneratedPrompt,
} from './bot-prompt'

const input = {
  name: 'Nina',
  label: 'Social media',
  description: "Runs the store's Instagram: post calendar, captions and replies.",
  language: 'pt-BR' as const,
}

describe('parseGeneratedPrompt', () => {
  it('reads the text inside the tag', () => {
    expect(
      parseGeneratedPrompt('Here it is:\n<system_prompt>\n# Nina\nYou are Nina.\n</system_prompt>\nDone'),
    ).toBe('# Nina\nYou are Nina.')
  })

  it('tolerates a missing closing tag and code fences', () => {
    expect(parseGeneratedPrompt('<system_prompt>\nYou are Nina.')).toBe('You are Nina.')
    expect(parseGeneratedPrompt('```markdown\nYou are Nina.\n```')).toBe('You are Nina.')
    expect(parseGeneratedPrompt('  You are Nina.  ')).toBe('You are Nina.')
  })
})

describe('botPromptRequest', () => {
  it('asks for the sections and the user language', () => {
    const system = botPromptSystem('pt-BR')
    for (const part of [
      'Identity and mission',
      'Responsibilities',
      'Working method',
      'Output style',
      'When to ask',
    ])
      expect(system).toContain(part)
    expect(system).toContain('Brazilian Portuguese')
    expect(botPromptSystem('en')).toContain('Write the whole text in English')
    expect(botPromptSystem('en')).not.toContain('talks to the user in')
    const request = botPromptRequest(input)
    expect(request.prompt).toContain('Bot name: Nina')
    expect(request.prompt).toContain(input.description)
    expect(request.prompt).not.toContain('<previous>')
  })

  it('asks for a shorter rewrite with the previous version', () => {
    const request = botPromptRequest(input, { text: 'long draft', tokens: 2000 })
    expect(request.prompt).toContain('about 2000 tokens')
    expect(request.prompt).toContain('<previous>\nlong draft\n</previous>')
  })
})

describe('fitPersona', () => {
  it('keeps text under the cap untouched', () => {
    expect(fitPersona('short')).toBe('short')
  })

  it('drops trailing paragraphs until it fits', () => {
    const paragraph = 'lengthy '.repeat(200).trim()
    const text = Array.from({ length: 12 }, (_, i) => `## ${i}\n${paragraph}`).join('\n\n')
    const fitted = fitPersona(text)
    expect(estimateTokens(fitted)).toBeLessThanOrEqual(PERSONA_MAX_TOKENS)
    expect(fitted.startsWith('## 0\n')).toBe(true)
    expect(fitted.endsWith(paragraph)).toBe(true)
  })

  it('cuts a single huge paragraph', () => {
    expect(estimateTokens(fitPersona('x'.repeat(20_000)))).toBeLessThanOrEqual(PERSONA_MAX_TOKENS)
  })
})

describe('generateBotPrompt', () => {
  it('returns the parsed prompt with its size', async () => {
    const requests: BotPromptRequest[] = []
    const result = await generateBotPrompt(input, async (request) => {
      requests.push(request)
      return '<system_prompt>You are Nina.</system_prompt>'
    })
    expect(requests).toHaveLength(1)
    expect(result).toEqual({
      systemPrompt: 'You are Nina.',
      tokens: estimateTokens('You are Nina.'),
      maxTokens: 1500,
    })
  })

  it('asks once for a shorter version and trims as a last resort', async () => {
    const long = Array.from({ length: 30 }, (_, i) => `## ${i}\n${'texto '.repeat(60)}`).join('\n\n')
    let calls = 0
    const result = await generateBotPrompt(input, async () => {
      calls++
      return `<system_prompt>${long}</system_prompt>`
    })
    expect(calls).toBe(2)
    expect(result.tokens).toBeLessThanOrEqual(PERSONA_MAX_TOKENS)
    expect(result.systemPrompt.startsWith('## 0')).toBe(true)
  })

  it('fails on an empty answer', async () => {
    await expect(generateBotPrompt(input, async () => '<system_prompt></system_prompt>')).rejects.toThrow(
      /empty/,
    )
  })
})
