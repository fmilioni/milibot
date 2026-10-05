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

describe('secret redaction of auth headers', () => {
  it('also redacts the credentials echoed without their scheme', () => {
    expect(redactSecrets('500 invalid token qa_draft_secret_558', ['Bearer qa_draft_secret_558'])).toBe(
      `500 invalid token ${REDACTED}`,
    )
    expect(redactSecrets('rejected: Token abcdef123', ['token  abcdef123'])).toBe(
      `rejected: Token ${REDACTED}`,
    )
  })

  it('redacts the base64, the decoded pair and the password of a Basic header', () => {
    const header = `Basic ${btoa('alice:pa55word-xyz')}`
    const echoed = `bad ${btoa('alice:pa55word-xyz')} for alice:pa55word-xyz (pa55word-xyz)`
    expect(redactSecrets(echoed, [header])).toBe(`bad ${REDACTED} for ${REDACTED} (${REDACTED})`)
    expect(redactSecrets('user alice', [header])).toBe('user alice')
  })

  it('redacts the lone token of a Basic header with an empty user or password', () => {
    const pat = `Basic ${btoa(':azdo-pat-123456')}`
    expect(redactSecrets('denied for azdo-pat-123456', [pat])).toBe(`denied for ${REDACTED}`)
    const key = `Basic ${btoa('sk_live_abc123:')}`
    expect(redactSecrets('invalid key sk_live_abc123', [key])).toBe(`invalid key ${REDACTED}`)
    expect(redactSecrets('pat short', [`Basic ${btoa(':short')}`])).toBe('pat short')
    expect(redactSecrets('key short', [`Basic ${btoa('short:')}`])).toBe('key short')
  })

  it('leaves short or non-credential parts alone', () => {
    expect(redactSecrets('Bearer abc and abc', ['Bearer abc'])).toBe(`${REDACTED} and abc`)
    expect(redactSecrets('ok then ok', ['Basic ok'])).toBe('ok then ok')
    expect(redactSecrets('pass short', [`Basic ${btoa('bob:short')}`])).toBe('pass short')
    expect(redactSecrets('not-base64!', ['Basic not-base64!'])).toBe(REDACTED)
  })
})
