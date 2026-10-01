import {
  cloneElement,
  type FocusEvent,
  isValidElement,
  type MouseEvent,
  type ReactElement,
  type ReactNode,
  useEffect,
  useId,
  useState,
} from 'react'

import { cn } from '@/lib/cn'
import { computeTooltipPosition, TooltipController, type TooltipSide } from '@/lib/tooltip'
import { FloatingPortal } from '@/ui/floating/FloatingPortal'
import { useAnchoredPosition } from '@/ui/floating/use-anchored-position'

type TriggerProps = {
  'aria-label'?: string
  'aria-describedby'?: string
  onMouseEnter?: (event: MouseEvent<HTMLElement>) => void
  onMouseLeave?: (event: MouseEvent<HTMLElement>) => void
  onMouseDown?: (event: MouseEvent<HTMLElement>) => void
  onFocus?: (event: FocusEvent<HTMLElement>) => void
  onBlur?: (event: FocusEvent<HTMLElement>) => void
}

interface TooltipProps {
  /** Nothing is shown (and the trigger is left untouched) when empty. */
  content: ReactNode
  /** A single element that forwards mouse/focus handlers to its DOM node. */
  children: ReactElement
  side?: TooltipSide
  /** Long content wraps up to this width (px) and scrolls past a max height. */
  maxWidth?: number
}

function isFocusVisible(element: Element): boolean {
  try {
    return element.matches(':focus-visible')
  } catch {
    return true
  }
}

/**
 * Fast, themed replacement for the native `title` tooltip: opens after a short hover or on keyboard
 * focus, closes on leave, blur, Escape, scroll or click. Rendered in a portal, so it never shifts
 * layout.
 */
export function Tooltip({ content, children, side = 'top', maxWidth = 260 }: TooltipProps) {
  const [open, setOpen] = useState(false)
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  const [controller] = useState(() => new TooltipController(setOpen))
  const id = useId()
  const empty = content === null || content === undefined || content === false || content === ''

  useEffect(() => () => controller.dispose(), [controller])

  useEffect(() => {
    if (empty) controller.reset()
  }, [empty, controller])

  useEffect(() => {
    if (!open) return
    const dismiss = () => controller.dismiss()
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') dismiss()
    }
    // Only scrolls that move the anchor (a streaming chat elsewhere must not close it).
    const onScroll = (event: Event) => {
      const target = event.target
      if (!(target instanceof Node) || target === document || target.contains(anchor)) dismiss()
    }
    document.addEventListener('keydown', onKey, true)
    document.addEventListener('scroll', onScroll, true)
    window.addEventListener('blur', dismiss)
    window.addEventListener('resize', dismiss)
    return () => {
      document.removeEventListener('keydown', onKey, true)
      document.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('blur', dismiss)
      window.removeEventListener('resize', dismiss)
    }
  }, [open, anchor, controller])

  if (empty || !isValidElement<TriggerProps>(children)) return children
  const props = children.props
  const redundant = typeof content === 'string' && content === props['aria-label']

  const trigger = cloneElement(children, {
    'aria-describedby':
      open && !redundant
        ? [props['aria-describedby'], id].filter(Boolean).join(' ')
        : props['aria-describedby'],
    onMouseEnter: (event: MouseEvent<HTMLElement>) => {
      props.onMouseEnter?.(event)
      setAnchor(event.currentTarget)
      controller.pointerEnter()
    },
    onMouseLeave: (event: MouseEvent<HTMLElement>) => {
      props.onMouseLeave?.(event)
      controller.pointerLeave()
    },
    onMouseDown: (event: MouseEvent<HTMLElement>) => {
      props.onMouseDown?.(event)
      controller.dismiss()
    },
    onFocus: (event: FocusEvent<HTMLElement>) => {
      props.onFocus?.(event)
      setAnchor(event.currentTarget)
      controller.focus(isFocusVisible(event.currentTarget))
    },
    onBlur: (event: FocusEvent<HTMLElement>) => {
      props.onBlur?.(event)
      controller.blur()
    },
  })

  return (
    <>
      {trigger}
      {open && anchor && (
        <TooltipBubble id={id} anchor={anchor} side={side} maxWidth={maxWidth}>
          {content}
        </TooltipBubble>
      )}
    </>
  )
}

function TooltipBubble({
  id,
  anchor,
  side,
  maxWidth,
  children,
}: {
  id: string
  anchor: HTMLElement
  side: TooltipSide
  maxWidth: number
  children: ReactNode
}) {
  const { ref, position } = useAnchoredPosition((el, viewport) => {
    const rect = anchor.getBoundingClientRect()
    return computeTooltipPosition(
      { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
      { width: el.offsetWidth, height: el.offsetHeight },
      viewport,
      side,
    )
  })

  return (
    <FloatingPortal
      ref={ref}
      position={position}
      id={id}
      role="tooltip"
      data-side={position?.side}
      className={cn(
        'pointer-events-none z-tooltip max-h-[40vh] w-max overflow-y-auto rounded-lg border border-border bg-surface-2 px-2 py-[5px] text-left text-sm leading-[1.45] font-normal break-words whitespace-pre-line text-fg shadow-[0_4px_14px_rgba(0,0,0,0.10)] dark:shadow-[0_6px_18px_rgba(0,0,0,0.45)]',
        position && 'tooltip-in',
      )}
      style={{ maxWidth }}
    >
      {children}
    </FloatingPortal>
  )
}
