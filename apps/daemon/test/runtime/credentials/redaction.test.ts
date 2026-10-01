import { describe, expect, it } from 'vitest'

import { maskSecret } from '../../../src/runtime/credentials/redaction'

describe('maskSecret', () => {
  it('keeps only a few characters', () => {
    expect(maskSecret('sk_live_1234567890abcd4Qe')).toBe('sk_liv••••••••4Qe')
    expect(maskSecret('short')).toBe('••••••••t')
    expect(maskSecret('medium-secret')).toBe('••••••••ret')
  })
})
