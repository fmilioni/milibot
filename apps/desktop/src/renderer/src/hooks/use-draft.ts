import { type Dispatch, type SetStateAction, useState } from 'react'

/** An editable copy of `value` (through `toDraft`), replaced whenever `value` changes. */
export function useDraft<T>(value: T): [T, Dispatch<SetStateAction<T>>]
export function useDraft<T, D>(value: T, toDraft: (value: T) => D): [D, Dispatch<SetStateAction<D>>]
export function useDraft<T, D>(value: T, toDraft?: (value: T) => D): [D, Dispatch<SetStateAction<D>>] {
  const make = (source: T) => (toDraft ? toDraft(source) : source) as D
  const [draft, setDraft] = useState(() => make(value))
  const [source, setSource] = useState(value)
  if (!Object.is(source, value)) {
    setSource(value)
    setDraft(make(value))
  }
  return [draft, setDraft]
}
