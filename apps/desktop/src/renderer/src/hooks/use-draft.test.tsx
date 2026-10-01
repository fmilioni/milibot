import { act, renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { useDraft } from './use-draft'

describe('useDraft', () => {
  it('keeps edits until the value changes, then takes the new value', () => {
    const { result, rerender } = renderHook(({ value }) => useDraft(value, String), {
      initialProps: { value: 3 },
    })
    expect(result.current[0]).toBe('3')
    act(() => result.current[1]('7'))
    rerender({ value: 3 })
    expect(result.current[0]).toBe('7')
    rerender({ value: 5 })
    expect(result.current[0]).toBe('5')
  })
})
