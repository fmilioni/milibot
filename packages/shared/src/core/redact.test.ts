import { describe, expect, it } from 'vitest'

import { REDACTED, redactSecrets } from './redact'

describe('secret redaction', () => {
  it('replaces secret values anywhere in a payload', () => {
    const payload = {
      argv: ['x', 'Bearer ntn_secret_value'],
      nested: { text: 'token=super-secret-token;', n: 3, keep: null },
    }
    expect(redactSecrets(payload, ['super-secret-token', 'ntn_secret_value', 'abc'])).toEqual({
      argv: ['x', `Bearer ${REDACTED}`],
      nested: { text: `token=${REDACTED};`, n: 3, keep: null },
    })
    expect(redactSecrets('abc abc', ['abc'])).toBe('abc abc')
  })
})
