import { ToolInputError } from '@milibot/agent/tools'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { DaemonError } from '../../../src/errors'
import { SecretRefError } from '../../../src/runtime/credentials/secret-refs'
import { toolErrorResult } from '../../../src/runtime/tools-core'
import { GuestError } from '../../../src/runtime/vm/guest-client'

const text = (result: { content: Array<{ type: string; text?: string }> }) =>
  result.content.map((c) => c.text ?? '').join('')

describe('toolErrorResult', () => {
  it('maps the errors tools throw on purpose, rethrows the rest', () => {
    const signal = new AbortController().signal
    expect(text(toolErrorResult(new ToolInputError('"x" is required'), signal))).toBe(
      'Invalid input: "x" is required',
    )
    const zodError = z.object({ a: z.string() }).safeParse({}).error
    expect(text(toolErrorResult(zodError, signal))).toMatch(/^Invalid input: /)
    expect(toolErrorResult(new DaemonError('conflict', 'busy'), signal)).toMatchObject({
      isError: true,
      content: [{ type: 'text', text: 'busy' }],
    })
    expect(text(toolErrorResult(new SecretRefError('unknown secret FOO'), signal))).toBe('unknown secret FOO')
    expect(text(toolErrorResult(new GuestError('path_not_found', 'no such file', 404), signal))).toBe(
      'VM error (path_not_found): no such file',
    )
    const unexpected = Object.assign(new Error('ENOENT: /Users/x/secret'), { code: 'ENOENT' })
    expect(() => toolErrorResult(unexpected, signal)).toThrow(unexpected)
    const stopped = new AbortController()
    stopped.abort()
    expect(() => toolErrorResult(new ToolInputError('late'), stopped.signal)).toThrow('late')
  })
})
