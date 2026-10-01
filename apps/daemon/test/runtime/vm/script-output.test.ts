import { describe, expect, it } from 'vitest'

import { parseKeyValueLines } from '../../../src/runtime/vm/script-output'

describe('parseKeyValueLines', () => {
  it('reads KEY=VALUE lines of a script', () => {
    expect(parseKeyValueLines('STATUS=reused\nwarning: x\n  BASE=main  \nBASE=dev\nlower=1\nEMPTY=')).toEqual(
      {
        STATUS: 'reused',
        BASE: 'dev',
        EMPTY: '',
      },
    )
  })
})
