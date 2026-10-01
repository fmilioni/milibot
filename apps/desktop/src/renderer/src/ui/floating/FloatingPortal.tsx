import type { CSSProperties, HTMLAttributes, Ref } from 'react'
import { createPortal } from 'react-dom'

import { cn } from '@/lib/cn'
import type { FloatingPosition } from '@/lib/floating'

type FloatingPortalProps = HTMLAttributes<HTMLDivElement> & {
  ref?: Ref<HTMLDivElement>
  /** From `useAnchoredPosition`; `null` renders it hidden so it can be measured. */
  position: FloatingPosition | null
  'data-menu'?: boolean
}

function placementStyle(position: FloatingPosition | null): CSSProperties {
  if (!position) return { left: 0, top: 0, visibility: 'hidden' }
  return { left: position.left, top: position.top, bottom: position.bottom, maxHeight: position.maxHeight }
}

/** A `fixed` layer on `document.body` at `position`: menus, dropdowns, popovers and tooltips. */
export function FloatingPortal({ ref, position, className, style, ...props }: FloatingPortalProps) {
  return createPortal(
    <div
      ref={ref}
      {...props}
      className={cn('fixed', className)}
      style={{ ...style, ...placementStyle(position) }}
    />,
    document.body,
  )
}
