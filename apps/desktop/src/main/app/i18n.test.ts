import { describe, expect, it } from 'vitest'

import { MAIN_STRINGS } from './i18n'

const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort()

describe('main process strings', () => {
  it('has the same keys and placeholders in every language', () => {
    const [reference, ...others] = Object.values(MAIN_STRINGS) as Record<string, string>[]
    for (const table of others) {
      expect(Object.keys(table).sort()).toEqual(Object.keys(reference!).sort())
      for (const [key, text] of Object.entries(table)) {
        expect(placeholders(text), key).toEqual(placeholders(reference![key]!))
      }
    }
  })
})
