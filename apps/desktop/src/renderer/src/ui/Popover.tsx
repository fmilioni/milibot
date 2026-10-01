import type { ReactNode } from 'react'

import { useDismiss } from '@/hooks/use-dismiss'
import { cn } from '@/lib/cn'
import { placePopover, type PopoverPlacement } from '@/lib/floating'
import { FloatingPortal } from '@/ui/floating/FloatingPortal'
import { useAnchoredPosition } from '@/ui/floating/use-anchored-position'

/**
 * A floating panel next to an anchor rect, kept on screen: under it and right-aligned (`below-end`), or over
 * it and left-aligned (`above-start`). Closes on a pointer down outside it (and outside `[data-menu]`, for
 * menus it opens, and `trigger`, which toggles it itself) and on Escape.
 */
export function Popover({
  anchor,
  onClose,
  children,
  menu = false,
  placement = 'below-end',
  trigger,
  label,
}: {
  anchor: DOMRect
  onClose: () => void
  children: ReactNode
  /** Styled like a menu (padding, background); otherwise the child brings its own box. */
  menu?: boolean
  placement?: PopoverPlacement
  trigger?: Element | null
  label?: string
}) {
  const { ref, position } = useAnchoredPosition((el, viewport) =>
    placePopover(anchor, el.getBoundingClientRect(), viewport, placement),
  )

  useDismiss(ref, true, onClose, {
    capture: true,
    ignore: (target) =>
      Boolean(trigger?.contains(target)) ||
      (target instanceof Element && target.closest('[data-menu]') !== null),
  })

  return (
    <FloatingPortal
      ref={ref}
      position={position}
      data-menu
      role={label ? 'dialog' : undefined}
      aria-label={label}
      className={cn(
        'z-menu',
        placement === 'above-start' && 'overflow-y-auto',
        menu &&
          'rounded-[10px] border border-border bg-surface-2 p-[5px] shadow-[0_10px_30px_rgba(0,0,0,0.18)] dark:shadow-[0_10px_30px_rgba(0,0,0,0.5)]',
      )}
    >
      {children}
    </FloatingPortal>
  )
}
