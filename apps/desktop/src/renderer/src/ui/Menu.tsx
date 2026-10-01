import { Check, ChevronRight } from 'lucide-react'
import { type ReactNode, useEffect, useState } from 'react'

import { cn } from '@/lib/cn'
import { placeAtPoint, placeBeside } from '@/lib/floating'
import { FloatingPortal } from '@/ui/floating/FloatingPortal'
import { useAnchoredPosition } from '@/ui/floating/use-anchored-position'

export type MenuEntry =
  | {
      type?: 'item'
      key: string
      label: string
      icon?: ReactNode
      shortcut?: string
      danger?: boolean
      disabled?: boolean
      /** A check mark on the right (a picked option). */
      checked?: boolean
      onSelect?: () => void
      submenu?: MenuEntry[]
      /** A custom submenu (instead of `submenu` entries); `close` closes the whole menu. */
      panel?: (close: () => void) => ReactNode
    }
  | { type: 'separator'; key: string }

interface MenuProps {
  entries: MenuEntry[]
  x: number
  y: number
  width?: number
  onClose: () => void
  label?: string
  /** Submenus close on their own but must not close the root on pointer events inside the root. */
  root?: boolean
  onSubmenuBack?: () => void
}

type Item = Extract<MenuEntry, { key: string; label: string }>

function isItem(entry: MenuEntry): entry is Item {
  return entry.type !== 'separator'
}

/** Floating menu (context menus, "+" menu); keyboard navigable, with one level of submenus. */
export function Menu({ entries, x, y, width = 230, onClose, label, root = true, onSubmenuBack }: MenuProps) {
  const { ref, position } = useAnchoredPosition((el, viewport) =>
    placeAtPoint({ x, y }, el.getBoundingClientRect(), viewport),
  )
  const [active, setActive] = useState(-1)
  const [openSub, setOpenSub] = useState<{ index: number; x: number; y: number } | null>(null)
  const items = entries.filter(isItem)

  useEffect(() => {
    ref.current?.focus()
  }, [ref])

  useEffect(() => {
    if (!root) return
    const onPointer = (event: PointerEvent) => {
      const target = event.target
      if (!(target instanceof Element) || !target.closest('[data-menu]')) onClose()
    }
    const onBlur = () => onClose()
    document.addEventListener('pointerdown', onPointer, true)
    window.addEventListener('blur', onBlur)
    return () => {
      document.removeEventListener('pointerdown', onPointer, true)
      window.removeEventListener('blur', onBlur)
    }
  }, [root, onClose])

  const openSubmenu = (index: number) => {
    const el = ref.current?.querySelector<HTMLElement>(`[data-index="${index}"]`)
    if (!el) return
    const rect = el.getBoundingClientRect()
    setOpenSub({ index, x: rect.right + 4, y: rect.top - 5 })
  }

  const select = (item: Item, index: number) => {
    if (item.disabled) return
    if (item.submenu || item.panel) {
      openSubmenu(index)
      return
    }
    item.onSelect?.()
    onClose()
  }

  const onKeyDown = (event: React.KeyboardEvent) => {
    const enabled = items.map((item, i) => (item.disabled ? -1 : i)).filter((i) => i >= 0)
    const move = (delta: number) => {
      const pos = enabled.indexOf(active)
      const next = enabled[(pos + delta + enabled.length) % enabled.length] ?? -1
      setActive(next)
    }
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault()
        move(1)
        break
      case 'ArrowUp':
        event.preventDefault()
        move(-1)
        break
      case 'ArrowRight':
        if (items[active]?.submenu || items[active]?.panel) {
          event.preventDefault()
          openSubmenu(active)
        }
        break
      case 'ArrowLeft':
        if (!root) {
          event.preventDefault()
          onSubmenuBack?.()
        }
        break
      case 'Enter':
      case ' ': {
        event.preventDefault()
        const item = items[active]
        if (item) select(item, active)
        break
      }
      case 'Escape':
        event.preventDefault()
        event.stopPropagation()
        if (root) onClose()
        else onSubmenuBack?.()
        break
      case 'Tab':
        event.preventDefault()
        break
    }
  }

  let itemIndex = -1
  const sub = openSub ? items[openSub.index] : undefined
  return (
    <>
      <FloatingPortal
        ref={ref}
        position={position}
        data-menu
        role="menu"
        aria-label={label}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        onContextMenu={(e) => e.preventDefault()}
        className="z-menu flex flex-col gap-px rounded-[10px] border border-border bg-surface-2 p-[5px] shadow-[0_10px_30px_rgba(0,0,0,0.18)] outline-none dark:shadow-[0_10px_30px_rgba(0,0,0,0.5)]"
        style={{ width }}
      >
        {entries.map((entry) => {
          if (!isItem(entry)) return <div key={entry.key} role="separator" className="my-px h-px bg-border" />
          itemIndex++
          const index = itemIndex
          const highlighted = index === active || openSub?.index === index
          return (
            <button
              key={entry.key}
              type="button"
              role={entry.checked !== undefined ? 'menuitemradio' : 'menuitem'}
              aria-checked={entry.checked}
              data-index={index}
              aria-disabled={entry.disabled || undefined}
              aria-haspopup={entry.submenu || entry.panel ? 'menu' : undefined}
              aria-expanded={entry.submenu || entry.panel ? openSub?.index === index : undefined}
              tabIndex={-1}
              onPointerEnter={() => {
                setActive(index)
                if (entry.submenu || entry.panel) openSubmenu(index)
                else setOpenSub(null)
              }}
              onClick={() => select(entry, index)}
              className={cn(
                'flex h-[30px] w-full items-center gap-[9px] rounded-md px-[9px] text-left text-base',
                highlighted && !entry.disabled && 'bg-surface-3',
                entry.disabled && 'opacity-45',
                entry.danger ? 'text-danger' : 'text-fg',
              )}
            >
              {entry.icon && (
                <span
                  className={cn(
                    'flex size-3.5 shrink-0 items-center',
                    entry.danger ? 'text-danger' : 'text-fg-secondary',
                  )}
                >
                  {entry.icon}
                </span>
              )}
              <span className="min-w-0 flex-1 truncate">{entry.label}</span>
              {entry.shortcut && <span className="text-xs text-fg-muted">{entry.shortcut}</span>}
              {entry.checked && <Check size={13} className="shrink-0 text-accent" aria-hidden />}
              {(entry.submenu || entry.panel) && <ChevronRight size={12} className="text-fg-muted" />}
            </button>
          )
        })}
      </FloatingPortal>
      {sub?.panel && openSub && (
        <MenuPanel x={openSub.x} y={openSub.y} onBack={() => setOpenSub(null)}>
          {sub.panel(onClose)}
        </MenuPanel>
      )}
      {sub?.submenu && openSub && (
        <Menu
          entries={sub.submenu}
          x={openSub.x}
          y={openSub.y}
          width={190}
          root={false}
          onClose={onClose}
          onSubmenuBack={() => {
            setOpenSub(null)
            ref.current?.focus()
          }}
        />
      )}
    </>
  )
}

/** A custom submenu panel next to its item (kept on screen); Escape or ← goes back to the menu. */
function MenuPanel({
  x,
  y,
  onBack,
  children,
}: {
  x: number
  y: number
  onBack: () => void
  children: ReactNode
}) {
  const { ref, position } = useAnchoredPosition((el, viewport) =>
    placeBeside({ x, y }, el.getBoundingClientRect(), viewport),
  )
  return (
    <FloatingPortal
      ref={ref}
      position={position}
      data-menu
      role="menu"
      tabIndex={-1}
      onKeyDown={(event) => {
        if (event.key === 'Escape' || event.key === 'ArrowLeft') {
          event.preventDefault()
          event.stopPropagation()
          onBack()
        }
      }}
      className="z-menu rounded-[10px] border border-border bg-surface-2 p-[5px] shadow-[0_10px_30px_rgba(0,0,0,0.18)] outline-none dark:shadow-[0_10px_30px_rgba(0,0,0,0.5)]"
    >
      {children}
    </FloatingPortal>
  )
}
