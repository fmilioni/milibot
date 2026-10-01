import { Ellipsis } from 'lucide-react'
import { useState } from 'react'

import { Menu, type MenuEntry } from './Menu'

/** "⋯" button that opens `entries` under it, right-aligned. */
export function MoreMenu({
  label,
  entries,
  width = 200,
  menuLabel,
}: {
  /** Accessible name of the button ("More options for X"). */
  label: string
  entries: MenuEntry[]
  width?: number
  /** Accessible name of the open menu. */
  menuLabel?: string
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
        className="focus-ring flex size-6 shrink-0 items-center justify-center rounded text-fg-muted hover:bg-surface-3 hover:text-fg"
      >
        <Ellipsis size={14} />
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
