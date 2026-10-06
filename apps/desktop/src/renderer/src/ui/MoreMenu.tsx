import { Ellipsis } from 'lucide-react'
import { useState } from 'react'

import { cn } from '@/lib/cn'

import { Menu, type MenuEntry } from './Menu'

/** "⋯" button that opens `entries` under it, right-aligned. */
export function MoreMenu({
  label,
  entries,
  width = 200,
  menuLabel,
  size = 'sm',
  className,
}: {
  /** Accessible name of the button ("More options for X"). */
  label: string
  entries: MenuEntry[]
  width?: number
  /** Accessible name of the open menu. */
  menuLabel?: string
  /** `sm`: 24px, for rows and tiles; `md`: 28px with a 32px pointer target, for headers. */
  size?: 'sm' | 'md'
  className?: string
}) {
  const [at, setAt] = useState<{ x: number; y: number } | null>(null)
  return (
    <>
      <button
        type="button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={at !== null}
        onClick={(e) => {
          const rect = e.currentTarget.getBoundingClientRect()
          setAt({ x: rect.right - width, y: rect.bottom + 4 })
        }}
        className={cn(
          'focus-ring flex shrink-0 items-center justify-center hover:bg-surface-3 hover:text-fg',
          size === 'md' ? 'hit size-7 rounded-lg text-fg-secondary' : 'size-6 rounded text-fg-muted',
          className,
        )}
      >
        <Ellipsis size={size === 'md' ? 16 : 14} />
      </button>
      {at && (
        <Menu
          entries={entries}
          x={at.x}
          y={at.y}
          width={width}
          onClose={() => setAt(null)}
          {...(menuLabel ? { label: menuLabel } : {})}
        />
      )}
    </>
  )
}
