import { type RefObject, useEffect } from 'react'

/**
 * Closes an open dropdown on a pointer down outside its trigger and list, on a scroll outside the list (it
 * would leave the trigger behind), and when the window resizes or loses focus.
 */
export function useDropdownDismiss(
  open: boolean,
  trigger: RefObject<HTMLElement | null>,
  list: RefObject<HTMLElement | null>,
  close: () => void,
): void {
  useEffect(() => {
    if (!open) return
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Node
      if (trigger.current?.contains(target) || list.current?.contains(target)) return
      close()
    }
    const onScroll = (event: Event) => {
      if (!list.current?.contains(event.target as Node)) close()
    }
    document.addEventListener('pointerdown', onPointer, true)
    document.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', close)
    window.addEventListener('blur', close)
    return () => {
      document.removeEventListener('pointerdown', onPointer, true)
      document.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', close)
      window.removeEventListener('blur', close)
    }
  }, [open, trigger, list, close])
}
