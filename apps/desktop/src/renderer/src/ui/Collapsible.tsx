import { type ReactNode, useLayoutEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { cn } from '@/lib/cn'

/**
 * Long content folded to `maxHeight` with a fade and "Show more"; short content renders as is. Measured after
 * layout, so it follows content that grows (images, a message still arriving while `enabled` is false).
 */
export function Collapsible({
  children,
  maxHeight = 320,
  enabled = true,
  fade = 'from-bg',
}: {
  children: ReactNode
  maxHeight?: number
  enabled?: boolean
  /** Gradient start matching the background behind the content. */
  fade?: string
}) {
  const { t } = useTranslation()
  const inner = useRef<HTMLDivElement>(null)
  const [tall, setTall] = useState(false)
  const [open, setOpen] = useState(false)

  useLayoutEffect(() => {
    const el = inner.current
    if (!el || !enabled) return
    // A little slack so content only slightly past the limit isn't folded to hide two lines.
    const measure = () => setTall(el.scrollHeight > maxHeight + 80)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [enabled, maxHeight])

  const folded = enabled && tall && !open
  return (
    <div className="flex flex-col items-start">
      <div
        ref={inner}
        className={cn('relative w-full', folded && 'overflow-hidden')}
        style={folded ? { maxHeight } : undefined}
      >
        {children}
        {folded && (
          <div
            className={`pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-linear-to-t ${fade} to-transparent`}
          />
        )}
      </div>
      {enabled && tall && (
        <button
          type="button"
          onClick={() => setOpen(!open)}
          aria-expanded={open}
          className="focus-ring mt-1 rounded text-sm font-medium text-accent hover:underline"
        >
          {open ? t('chat.showLess') : t('chat.showMore')}
        </button>
      )}
    </div>
  )
}
