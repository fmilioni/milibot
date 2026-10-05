import type { KeyboardEvent } from 'react'

import { hasLayerAbove } from './floating/layers'

/**
 * A modal dialog's keys: Escape closes it unless a child already handled it or a layer opened above it is on
 * screen; Tab cycles within it.
 */
export function handleDialogKeys(event: KeyboardEvent, root: HTMLElement | null, onClose: () => void): void {
  if (event.key === 'Escape') {
    if (event.defaultPrevented || (root && hasLayerAbove(root))) return
    event.stopPropagation()
    onClose()
    return
  }
  if (event.key !== 'Tab' || !root) return
  const focusable = [
    ...root.querySelectorAll<HTMLElement>('button:not([disabled]), input, textarea, select, [tabindex="0"]'),
  ]
  const first = focusable[0]
  const last = focusable.at(-1)
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault()
    last?.focus()
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault()
    first?.focus()
  }
}
