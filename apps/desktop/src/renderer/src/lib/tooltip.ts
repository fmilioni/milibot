export type TooltipSide = 'top' | 'bottom' | 'left' | 'right'

export interface Box {
  left: number
  top: number
  width: number
  height: number
}

export interface Size {
  width: number
  height: number
}

export interface TooltipPosition {
  side: TooltipSide
  left: number
  top: number
}

const FALLBACKS: Record<TooltipSide, TooltipSide[]> = {
  top: ['top', 'bottom', 'right', 'left'],
  bottom: ['bottom', 'top', 'right', 'left'],
  left: ['left', 'right', 'top', 'bottom'],
  right: ['right', 'left', 'top', 'bottom'],
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, Math.max(min, max)))
}

/** Free space between the anchor and the viewport edge on `side`, minus the gap and the tooltip itself. */
function room(
  side: TooltipSide,
  anchor: Box,
  tip: Size,
  viewport: Size,
  gap: number,
  margin: number,
): number {
  switch (side) {
    case 'top':
      return anchor.top - gap - tip.height - margin
    case 'bottom':
      return viewport.height - (anchor.top + anchor.height) - gap - tip.height - margin
    case 'left':
      return anchor.left - gap - tip.width - margin
    case 'right':
      return viewport.width - (anchor.left + anchor.width) - gap - tip.width - margin
  }
}

/**
 * Places the tooltip on the preferred side when it fits, otherwise on the first fallback that does
 * (or the roomiest one), centered on the anchor and clamped inside the viewport margins.
 */
export function computeTooltipPosition(
  anchor: Box,
  tip: Size,
  viewport: Size,
  preferred: TooltipSide = 'top',
  gap = 6,
  margin = 8,
): TooltipPosition {
  const order = FALLBACKS[preferred]
  const side =
    order.find((s) => room(s, anchor, tip, viewport, gap, margin) >= 0) ??
    order.reduce((best, s) =>
      room(s, anchor, tip, viewport, gap, margin) > room(best, anchor, tip, viewport, gap, margin) ? s : best,
    )

  let left: number
  let top: number
  if (side === 'top' || side === 'bottom') {
    left = anchor.left + anchor.width / 2 - tip.width / 2
    top = side === 'top' ? anchor.top - gap - tip.height : anchor.top + anchor.height + gap
  } else {
    top = anchor.top + anchor.height / 2 - tip.height / 2
    left = side === 'left' ? anchor.left - gap - tip.width : anchor.left + anchor.width + gap
  }
  return {
    side,
    left: Math.round(clamp(left, margin, viewport.width - tip.width - margin)),
    top: Math.round(clamp(top, margin, viewport.height - tip.height - margin)),
  }
}

export interface TooltipTimers {
  setTimeout: (fn: () => void, ms: number) => unknown
  clearTimeout: (id: unknown) => void
  now: () => number
}

const defaultTimers: TooltipTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
  now: () => Date.now(),
}

/** Tooltips opened shortly after another one closed skip the delay (moving along a toolbar). */
export interface TooltipWarmth {
  lastClosedAt: number
}

const sharedWarmth: TooltipWarmth = { lastClosedAt: -Infinity }

export interface TooltipControllerOptions {
  delay?: number
  warmMs?: number
  timers?: TooltipTimers
  warmth?: TooltipWarmth
}

/**
 * Open/close state machine behind `Tooltip`: hover opens after `delay`, keyboard focus opens at once,
 * leave/blur close, and a dismissal (Escape, scroll, click) keeps it closed until the pointer leaves
 * or focus moves.
 */
export class TooltipController {
  open = false
  private hovered = false
  private focused = false
  private suppressed = false
  private timer: unknown = null
  private readonly delay: number
  private readonly warmMs: number
  private readonly timers: TooltipTimers
  private readonly warmth: TooltipWarmth

  constructor(
    private readonly onChange: (open: boolean) => void,
    {
      delay = 120,
      warmMs = 300,
      timers = defaultTimers,
      warmth = sharedWarmth,
    }: TooltipControllerOptions = {},
  ) {
    this.delay = delay
    this.warmMs = warmMs
    this.timers = timers
    this.warmth = warmth
  }

  pointerEnter(): void {
    this.hovered = true
    if (this.open || this.suppressed || this.timer !== null) return
    const warm = this.timers.now() - this.warmth.lastClosedAt < this.warmMs
    if (warm) {
      this.set(true)
      return
    }
    this.timer = this.timers.setTimeout(() => {
      this.timer = null
      if (this.hovered && !this.suppressed) this.set(true)
    }, this.delay)
  }

  pointerLeave(): void {
    this.hovered = false
    this.suppressed = false
    this.cancel()
    if (!this.focused) this.set(false)
  }

  /** Only keyboard focus (`:focus-visible`) opens; focus from a click must not. */
  focus(visible: boolean): void {
    if (!visible) return
    this.focused = true
    if (this.suppressed) return
    this.cancel()
    this.set(true)
  }

  blur(): void {
    this.focused = false
    this.suppressed = false
    this.cancel()
    if (!this.hovered) this.set(false)
  }

  dismiss(): void {
    this.suppressed = true
    this.cancel()
    this.set(false)
  }

  /** Forgets hover/focus/dismissal (the trigger stopped reporting them) and closes. */
  reset(): void {
    this.hovered = false
    this.focused = false
    this.suppressed = false
    this.cancel()
    this.set(false)
  }

  dispose(): void {
    this.cancel()
  }

  private cancel(): void {
    if (this.timer === null) return
    this.timers.clearTimeout(this.timer)
    this.timer = null
  }

  private set(open: boolean): void {
    if (this.open === open) return
    this.open = open
    if (!open) this.warmth.lastClosedAt = this.timers.now()
    this.onChange(open)
  }
}
