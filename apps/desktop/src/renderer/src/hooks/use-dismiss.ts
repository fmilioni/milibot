import { type RefObject, useEffect, useEffectEvent } from 'react'

interface DismissOptions {
  /** Pointer downs on these targets keep it open (e.g. the trigger that toggles it). */
  ignore?: (target: Node) => boolean
  /** Listens in the capture phase, before handlers that stop propagation. */
  capture?: boolean
}

/** Calls `onDismiss` on a pointer down outside `ref` or on Escape while `active`. */
export function useDismiss(
  ref: RefObject<HTMLElement | null>,
  active: boolean,
  onDismiss: () => void,
  { ignore, capture = false }: DismissOptions = {},
): void {
  const dismiss = useEffectEvent(onDismiss)
  const ignored = useEffectEvent((target: Node) => ignore?.(target) ?? false)
  useEffect(() => {
    if (!active) return
    const onPointer = (event: PointerEvent) => {
      const target = event.target
      if (!(target instanceof Node)) return
      if (ref.current?.contains(target) || ignored(target)) return
      dismiss()
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') dismiss()
    }
    document.addEventListener('pointerdown', onPointer, capture)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onPointer, capture)
      document.removeEventListener('keydown', onKey)
    }
  }, [ref, active, capture])
}
