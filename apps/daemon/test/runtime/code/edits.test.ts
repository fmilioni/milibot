import { describe, expect, it } from 'vitest'

import { applyEdits, EditError } from '../../../src/runtime/code/edits'

describe('text edits', () => {
  it('applies edits in order and fails as a whole', () => {
    const edited = applyEdits('one two two three', [
      { oldText: 'one', newText: '1', replaceAll: false },
      { oldText: 'two', newText: '2', replaceAll: true },
    ])
    expect(edited).toEqual({ content: '1 2 2 three', replacements: 3 })
    expect(() =>
      applyEdits('a b', [
        { oldText: 'a', newText: 'b', replaceAll: false },
        { oldText: 'b', newText: 'c', replaceAll: false },
      ]),
    ).toThrow(/edits\[1\]: the old text matches 2 times/)
    expect(() => applyEdits('a', [{ oldText: 'z', newText: '', replaceAll: false }])).toThrow(EditError)
  })
})
