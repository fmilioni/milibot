import { describe, expect, it } from 'vitest'

import { secretRefRegex } from './user-requests'

describe('secret references', () => {
  it('finds secret references', () => {
    const text = 'user {{secret:DB_USER}} pass {{secret:DB_PASS}} bad {{secret:1X}}'
    expect([...text.matchAll(secretRefRegex())].map((m) => m[1])).toEqual(['DB_USER', 'DB_PASS'])
  })
})
