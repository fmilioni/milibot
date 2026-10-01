import { describe, expect, it } from 'vitest'

import {
  argsObject,
  exactInteger,
  flagArg,
  numberArg,
  optionalBoolean,
  optionalInteger,
  optionalIntLike,
  optionalNumber,
  optionalString,
  rawTextArg,
  requireString,
  stringListArg,
  textArg,
  toolArgs,
  trimmedString,
} from './args'
import { toolError, ToolInputError, toolText } from './result'

describe('toolArgs', () => {
  it('returns the argument object, or {} for anything else', () => {
    expect(toolArgs({ arguments: { a: 1 } })).toEqual({ a: 1 })
    expect(toolArgs({ arguments: null })).toEqual({})
    expect(toolArgs({ arguments: [1, 2] })).toEqual({})
    expect(toolArgs({ arguments: 'x' })).toEqual({})
  })

  it('rejects arguments the provider could not parse', () => {
    const call = { arguments: { __invalidJson: `{"a": ${'x'.repeat(300)}` } }
    expect(() => toolArgs(call)).toThrow(ToolInputError)
    expect(() => toolArgs(call)).toThrow(/^arguments are not valid JSON: \{"a": x+$/)
    try {
      toolArgs(call)
    } catch (err) {
      expect((err as Error).message.length).toBe('arguments are not valid JSON: '.length + 200)
    }
  })
})

describe('argument readers', () => {
  it('requireString refuses missing or empty values', () => {
    expect(requireString({ path: '/workspace/a' }, 'path')).toBe('/workspace/a')
    expect(() => requireString({ path: '' }, 'path')).toThrow('"path" is required')
    expect(() => requireString({ path: 3 }, 'path')).toThrow(ToolInputError)
  })

  it('optionalString keeps non-empty strings only', () => {
    expect(optionalString({ a: ' x ' }, 'a')).toBe(' x ')
    expect(optionalString({ a: '' }, 'a')).toBeUndefined()
    expect(optionalString({ a: 1 }, 'a')).toBeUndefined()
    expect(optionalString({}, 'a')).toBeUndefined()
  })

  it('optionalInteger rounds and clamps, and refuses non-numbers', () => {
    expect(optionalInteger({}, 'n', 1, 10)).toBeNull()
    expect(optionalInteger({ n: null }, 'n', 1, 10)).toBeNull()
    expect(optionalInteger({ n: 4.6 }, 'n', 1, 10)).toBe(5)
    expect(optionalInteger({ n: 99 }, 'n', 1, 10)).toBe(10)
    expect(optionalInteger({ n: -3 }, 'n', 1, 10)).toBe(1)
    expect(() => optionalInteger({ n: '3' }, 'n', 1, 10)).toThrow('"n" must be a number')
    expect(() => optionalInteger({ n: Number.NaN }, 'n', 1, 10)).toThrow(ToolInputError)
  })

  it('optionalBoolean accepts booleans only', () => {
    expect(optionalBoolean({ b: true }, 'b')).toBe(true)
    expect(optionalBoolean({ b: false }, 'b')).toBe(false)
    expect(optionalBoolean({}, 'b')).toBeUndefined()
    expect(() => optionalBoolean({ b: 'yes' }, 'b')).toThrow('"b" must be true or false')
  })

  it('trimmedString trims strings and drops the rest', () => {
    expect(trimmedString('  hi ')).toBe('hi')
    expect(trimmedString(3)).toBe('')
    expect(trimmedString(undefined)).toBe('')
  })
})

describe('tool results', () => {
  it('builds text results with optional error flag and activity', () => {
    expect(toolText('ok')).toEqual({ content: [{ type: 'text', text: 'ok' }] })
    expect(toolText('bad', true)).toEqual({ content: [{ type: 'text', text: 'bad' }], isError: true })
    expect(toolError('bad', { detail: 'page' })).toEqual({
      content: [{ type: 'text', text: 'bad' }],
      isError: true,
      activity: { detail: 'page' },
    })
  })

  it('ToolInputError is an Error with its own name', () => {
    const err = new ToolInputError('x')
    expect(err).toBeInstanceOf(Error)
    expect(err.name).toBe('ToolInputError')
  })
})

describe('argsObject', () => {
  it('returns the arguments object, or {} for anything else, without checking for invalid JSON', () => {
    expect(argsObject({ a: 1 })).toEqual({ a: 1 })
    expect(argsObject(null)).toEqual({})
    expect(argsObject('x')).toEqual({})
    expect(argsObject({ __invalidJson: '{' })).toEqual({ __invalidJson: '{' })
  })
})

describe('lenient argument readers', () => {
  it('reads text, trimmed and cut, or as given', () => {
    expect(textArg({ goal: '  ship it  ' }, 'goal')).toBe('ship it')
    expect(textArg({ goal: 'abcdef' }, 'goal', 3)).toBe('abc')
    expect(textArg({ goal: 3 }, 'goal')).toBe('')
    expect(rawTextArg({ body: '  x\n' }, 'body')).toBe('  x\n')
    expect(rawTextArg({}, 'body')).toBe('')
  })

  it('reads numbers with their fallback and range', () => {
    const range = { min: 1, max: 20, fallback: 1, round: true }
    expect(numberArg({ n: 7.6 }, 'n', range)).toBe(8)
    expect(numberArg({ n: 99 }, 'n', range)).toBe(20)
    expect(numberArg({ n: '5' }, 'n', range)).toBe(1)
    expect(numberArg({ n: 0.5 }, 'n', { min: 0.1, max: 10, fallback: 1 })).toBe(0.5)
    expect(optionalNumber({ n: 2.5 }, 'n')).toBe(2.5)
    expect(optionalNumber({ n: 'x' }, 'n')).toBeUndefined()
  })

  it('reads integers strictly or also from numeric strings', () => {
    expect(exactInteger({ n: 3 }, 'n')).toBe(3)
    expect(exactInteger({ n: 3.5 }, 'n')).toBeNull()
    expect(exactInteger({ n: '3' }, 'n')).toBeNull()
    expect(optionalIntLike({ n: ' 12 ' }, 'n')).toBe(12)
    expect(optionalIntLike({ n: 2.4 }, 'n')).toBe(2)
    expect(optionalIntLike({ n: '1.5' }, 'n')).toBeNull()
  })

  it('reads flags and string lists without errors', () => {
    expect(flagArg({ on: true }, 'on')).toBe(true)
    expect(flagArg({ on: 'true' }, 'on')).toBeUndefined()
    expect(stringListArg({ d: [' a ', '', 3, 'b'] }, 'd')).toEqual(['a', 'b'])
    expect(stringListArg({ d: 'a' }, 'd')).toEqual(['a'])
    expect(stringListArg({ d: 'a, b' }, 'd', { split: ',' })).toEqual(['a', 'b'])
    expect(stringListArg({}, 'd')).toEqual([])
  })
})
