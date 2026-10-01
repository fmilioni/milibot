import { useCallback, useEffect, useRef, useState } from 'react'

/** `copy(text)` plus a `copied` flag that stays on for a moment, for buttons that switch to a check mark. */
export function useCopyFlash(ms = 1500): [copied: boolean, copy: (text: string) => void] {
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])
  const copy = useCallback(
    (text: string) => {
      void navigator.clipboard.writeText(text).then(() => {
        setCopied(true)
        clearTimeout(timer.current)
        timer.current = setTimeout(() => setCopied(false), ms)
      })
    },
    [ms],
  )
  return [copied, copy]
}
