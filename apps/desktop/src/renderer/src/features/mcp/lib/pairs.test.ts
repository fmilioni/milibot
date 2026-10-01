import type { McpServer } from '@milibot/shared'
import { describe, expect, it } from 'vitest'

import { pair, pairsOf, toInput } from './pairs'

describe('pairs', () => {
  it('gives each new row its own key', () => {
    expect(pair().key).not.toBe(pair().key)
  })

  it('reads a server section, marking stored secrets as saved', () => {
    const server = {
      env: [
        { name: 'TOKEN', secret: true, hasValue: true },
        { name: 'MODE', value: 'fast', secret: false, hasValue: true },
      ],
    } as unknown as McpServer
    const rows = pairsOf(server, 'env')
    expect(rows.map(({ name, value, secret, saved }) => ({ name, value, secret, saved }))).toEqual([
      { name: 'TOKEN', value: '', secret: true, saved: true },
      { name: 'MODE', value: 'fast', secret: false, saved: false },
    ])
    expect(pairsOf(undefined, 'headers')).toEqual([])
  })

  it('sends named rows, keeping a stored secret left empty', () => {
    expect(
      toInput([
        pair({ name: ' TOKEN ', secret: true, saved: true }),
        pair({ name: 'KEY', value: 'new', secret: true, saved: true }),
        pair({ name: 'MODE', value: 'fast' }),
        pair({ name: '  ', value: 'ignored' }),
      ]),
    ).toEqual([
      { name: 'TOKEN', secret: true },
      { name: 'KEY', secret: true, value: 'new' },
      { name: 'MODE', secret: false, value: 'fast' },
    ])
  })
})
