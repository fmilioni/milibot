import { describe, expect, it } from 'vitest'

import { type RefOptions, resolveByRef } from '../../../src/runtime/tools-core'

interface Row {
  id: string
  name: string
  own?: boolean
  archived?: boolean
}

const rows: Row[] = [
  { id: 'r1', name: 'Launch plan' },
  { id: 'r2', name: 'Launch plan', own: true },
  { id: 'r3', name: 'Café' },
  { id: 'r4', name: 'Old launch notes', archived: true },
]

const options = (ambiguous: RefOptions<Row>['ambiguous']): RefOptions<Row> => ({
  id: (r) => r.id,
  names: (r) => [r.name],
  ambiguous,
})

describe('resolveByRef', () => {
  it('finds by id, then exact name, then by substring', () => {
    const first = options({ exact: 'first', partial: 'first' })
    expect(resolveByRef(rows, ' r3 ', first)).toEqual({ found: rows[2] })
    expect(resolveByRef(rows, 'CAFE', first)).toEqual({ found: rows[2] })
    expect(resolveByRef(rows, 'notes', first)).toEqual({ found: rows[3] })
    expect(resolveByRef(rows, 'nothing', first)).toEqual({ missing: true })
    expect(resolveByRef(rows, '  ', first)).toEqual({ missing: true })
  })

  it('prefers rows in order, or reports the ambiguity', () => {
    expect(
      resolveByRef(rows, 'launch plan', {
        ...options({ exact: 'first', partial: 'first' }),
        prefer: [(r) => !!r.own],
      }),
    ).toEqual({ found: rows[1] })
    expect(resolveByRef(rows, 'launch plan', options({ exact: 'report', partial: 'report' }))).toEqual({
      ambiguous: [rows[0], rows[1]],
    })
    expect(resolveByRef(rows, 'launch', options({ exact: 'first', partial: 'report' }))).toEqual({
      ambiguous: [rows[0], rows[1], rows[3]],
    })
  })

  it('limits substring matches to the allowed rows', () => {
    const live = {
      ...options({ exact: 'first', partial: 'report' }),
      partialAllowed: (r: Row) => !r.archived,
    }
    expect(resolveByRef(rows, 'notes', live)).toEqual({ missing: true })
    expect(resolveByRef(rows, 'old launch notes', live)).toEqual({ found: rows[3] })
  })
})
