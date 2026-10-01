import { describe, expect, it } from 'vitest'

import { cn } from './cn'

describe('cn', () => {
  it('joins truthy class names and skips the rest', () => {
    expect(cn('a', false, null, undefined, 0, '', 'b c')).toBe('a b c')
  })
})
