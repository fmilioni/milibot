import { type ReactNode, useId } from 'react'

import { cn } from '@/lib/cn'

/**
 * A clickable area whose text may hold links, which can't sit inside a <button>: the button covers the
 * area, named by the text drawn over it, and only the text's links take the pointer. `className` lays out
 * the text; the wrapper is the `group` for hover styles.
 */
export function StretchedButton({
  onClick,
  className,
  children,
}: {
  onClick: () => void
  className?: string
  children: ReactNode
}) {
  const id = useId()
  return (
    <div className="group relative">
      <button
        type="button"
        onClick={onClick}
        aria-labelledby={id}
        className="focus-ring absolute inset-0 rounded"
      />
      <div
        id={id}
        className={cn('pointer-events-none relative text-left [&_a]:pointer-events-auto', className)}
      >
        {children}
      </div>
    </div>
  )
}
