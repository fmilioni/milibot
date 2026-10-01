import { describe, expect, it } from 'vitest'

import { cleanToolSchema, toAnthropicTool, toOpenAiTool } from './tool-schema'

describe('schema conversion', () => {
  it('inlines local refs, drops unsupported keywords and keeps the object root', () => {
    const schema = {
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      properties: {
        filter: { $ref: '#/$defs/Filter', description: 'What to match' },
        limit: { type: 'integer', default: 10, examples: [5] },
      },
      required: ['filter', 'missing'],
      $defs: {
        Filter: {
          type: 'object',
          properties: { label: { type: 'string', readOnly: true }, child: { $ref: '#/$defs/Filter' } },
        },
      },
    }
    const openai = cleanToolSchema(schema, 'openai')
    expect(openai).toEqual({
      type: 'object',
      properties: {
        filter: {
          type: 'object',
          description: 'What to match',
          properties: {
            label: { type: 'string' },
            child: {},
          },
        },
        limit: { type: 'integer', default: 10 },
      },
      required: ['filter'],
    })
    const anthropic = cleanToolSchema(schema, 'anthropic') as {
      properties: { filter: { properties: { label: unknown } } }
    }
    expect(anthropic.properties.filter.properties.label).toEqual({ type: 'string', readOnly: true })
  })

  it('turns a root union or a missing schema into an object schema', () => {
    expect(cleanToolSchema(undefined, 'openai')).toEqual({ type: 'object', properties: {} })
    expect(
      cleanToolSchema(
        {
          anyOf: [
            { type: 'object', properties: { a: { type: 'string' } } },
            { type: 'object', properties: { b: {} } },
          ],
        },
        'anthropic',
      ),
    ).toEqual({ type: 'object', properties: { a: { type: 'string' }, b: {} } })
  })

  it('builds OpenAI function tools and Anthropic tools', () => {
    const tool = {
      name: 'mcp__x__y',
      description: 'd',
      inputSchema: { type: 'object', properties: {}, $schema: 's' },
    }
    expect(toOpenAiTool(tool)).toEqual({
      type: 'function',
      function: { name: 'mcp__x__y', description: 'd', parameters: { type: 'object', properties: {} } },
    })
    expect(toAnthropicTool(tool)).toEqual({
      name: 'mcp__x__y',
      description: 'd',
      input_schema: { type: 'object', properties: {} },
    })
  })
})
