import { describe, expect, it } from 'vitest'

import { fileSlug } from '../../../src/runtime/design/format'

describe('export file names', () => {
  it('keeps the slugs of exported files', () => {
    expect(fileSlug('Task app')).toBe('task-app')
    expect(fileSlug('Home · Crème Brûlée')).toBe('home-creme-brulee')
    expect(fileSlug('!!!')).toBe('frame')
    expect(fileSlug(`${'a'.repeat(59)} b`)).toBe(`${'a'.repeat(59)}-`)
  })
})
