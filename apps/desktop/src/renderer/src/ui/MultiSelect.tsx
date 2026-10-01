import { Check, ChevronDown } from 'lucide-react'
import { type ReactNode, useCallback, useId, useRef, useState } from 'react'

import { cn } from '@/lib/cn'
import { computeDropdownPosition } from '@/lib/select'
import { FloatingPortal } from '@/ui/floating/FloatingPortal'
import { useAnchoredPosition } from '@/ui/floating/use-anchored-position'
import { useDropdownDismiss } from '@/ui/floating/use-dropdown-dismiss'

interface MultiSelectOption {
  value: string
  label: string
}

interface MultiSelectProps {
  /** `all` = every option, current and future (the "all" entry is checked). */
  value: 'all' | string[]
  options: MultiSelectOption[]
  onChange: (value: 'all' | string[]) => void
  label: string
  allLabel: string
  /** Trigger text when nothing is picked. */
  placeholder: string
  id?: string
  tone?: 'surface' | 'surface-2'
  className?: string
  /** `chips`: a compact trigger showing the picked names as chips (list rows), after `icon`. */
  variant?: 'field' | 'chips'
  icon?: ReactNode
}

/**
 * Multi-select combobox with an "all" entry, styled like `Select`: the options are a listbox in a
 * portal (`aria-multiselectable`), toggled with click, Space or Enter; the menu stays open.
 */
export function MultiSelect({
  value,
  options,
  onChange,
  label,
  allLabel,
  placeholder,
  id,
  tone = 'surface',
  className = '',
  variant = 'field',
  icon,
}: MultiSelectProps) {
  const baseId = useId()
  const listId = `${baseId}-list`
  const triggerRef = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const [minWidth, setMinWidth] = useState(0)
  // Index 0 is the "all" entry.
  const entries = [{ value: '*', label: allLabel }, ...options]
  const isChecked = (index: number) =>
    index === 0 ? value === 'all' : value === 'all' || value.includes(entries[index]?.value as string)

  const close = useCallback(() => setOpen(false), [])

  const toggle = (index: number) => {
    if (index === 0) {
      onChange(value === 'all' ? [] : 'all')
      return
    }
    const option = entries[index]
    if (!option) return
    const current = value === 'all' ? options.map((o) => o.value) : value
    const next = current.includes(option.value)
      ? current.filter((v) => v !== option.value)
      : [...current, option.value]
    onChange(next)
  }

  const { ref: listRef, position } = useAnchoredPosition((list, viewport) => {
    const rect = triggerRef.current?.getBoundingClientRect() ?? new DOMRect()
    return computeDropdownPosition(
      { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
      { width: list.offsetWidth, height: list.scrollHeight },
      viewport,
    )
  }, open)
  useDropdownDismiss(open, triggerRef, listRef, close)

  const onKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    const key = event.key
    if (!open) {
      if (key === 'ArrowDown' || key === 'ArrowUp' || key === 'Enter' || key === ' ') {
        event.preventDefault()
        setMinWidth(triggerRef.current?.getBoundingClientRect().width ?? 0)
        setActive(0)
        setOpen(true)
      }
      return
    }
    if (key === 'ArrowDown' || key === 'ArrowUp') {
      event.preventDefault()
      setActive((i) => Math.max(0, Math.min(entries.length - 1, i + (key === 'ArrowDown' ? 1 : -1))))
    } else if (key === 'Home' || key === 'End') {
      event.preventDefault()
      setActive(key === 'Home' ? 0 : entries.length - 1)
    } else if (key === 'Enter' || key === ' ') {
      event.preventDefault()
      toggle(active)
    } else if (key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      close()
    } else if (key === 'Tab') {
      close()
    }
  }

  const picked =
    value === 'all' ? [allLabel] : options.filter((o) => value.includes(o.value)).map((o) => o.label)
  const names = picked.join(', ')
  const chips = variant === 'chips'

  return (
    <>
      <button
        ref={triggerRef}
        id={id}
        type="button"
        role="combobox"
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open ? `${baseId}-opt-${active}` : undefined}
        onClick={() => {
          if (open) return close()
          setMinWidth(triggerRef.current?.getBoundingClientRect().width ?? 0)
          setActive(0)
          setOpen(true)
        }}
        onKeyDown={onKeyDown}
        onBlur={close}
        className={
          chips
            ? `focus-ring flex max-w-full min-w-0 items-center gap-1.5 rounded-md px-1 py-0.5 text-left outline-none hover:bg-surface-3 ${
                open ? 'bg-surface-3' : ''
              } ${className}`
            : `flex h-[34px] w-full items-center gap-2 rounded-[7px] border pr-2.5 pl-3 text-left text-base text-fg outline-none ${
                open ? 'border-accent' : 'border-border focus-visible:border-accent'
              } ${tone === 'surface' ? 'bg-surface' : 'bg-surface-2'} ${className}`
        }
      >
        {chips ? (
          <>
            {icon && <span className="shrink-0 text-fg-muted">{icon}</span>}
            {picked.length === 0 ? (
              <span className="truncate text-xs text-fg-muted">{placeholder}</span>
            ) : (
              picked.map((name) => (
                <span
                  key={name}
                  className="inline-flex h-[17px] min-w-0 shrink items-center truncate rounded-md bg-surface-3 px-[7px] text-xs leading-none text-fg-secondary"
                >
                  {name}
                </span>
              ))
            )}
          </>
        ) : (
          <>
            <span className={cn('min-w-0 flex-1 truncate', !names && 'text-fg-muted')}>
              {names || placeholder}
            </span>
            <ChevronDown
              size={12}
              aria-hidden
              className={cn(
                'shrink-0 text-fg-muted transition-transform motion-reduce:transition-none',
                open && 'rotate-180',
              )}
            />
          </>
        )}
      </button>
      {open && (
        <FloatingPortal
          ref={listRef}
          position={position}
          id={listId}
          role="listbox"
          aria-label={label}
          aria-multiselectable
          tabIndex={-1}
          data-menu
          onMouseDown={(e) => e.preventDefault()}
          className="scroll-slim z-dropdown flex w-max max-w-[340px] flex-col gap-px overflow-y-auto overscroll-contain rounded-[10px] border border-border bg-surface-2 p-[5px] shadow-[0_10px_30px_rgba(0,0,0,0.18)] outline-none dark:shadow-[0_10px_30px_rgba(0,0,0,0.5)]"
          style={{ minWidth }}
        >
          {entries.map((entry, index) => {
            const checked = isChecked(index)
            return (
              <div
                key={entry.value}
                id={`${baseId}-opt-${index}`}
                role="option"
                aria-selected={checked}
                onPointerMove={() => active !== index && setActive(index)}
                onClick={() => toggle(index)}
                className={cn(
                  'flex min-h-[30px] cursor-default items-center gap-[9px] rounded-md px-[9px] py-1.5',
                  index === active && 'bg-surface-3',
                  index === 0 && options.length > 0 && 'mb-px',
                )}
              >
                <span
                  className={cn(
                    'flex size-3.5 shrink-0 items-center justify-center rounded-[4px] border',
                    checked ? 'border-accent bg-accent text-on-accent' : 'border-border bg-surface',
                  )}
                >
                  {checked && <Check size={10} strokeWidth={3} aria-hidden />}
                </span>
                <span className="truncate text-base leading-4 text-fg">{entry.label}</span>
              </div>
            )
          })}
        </FloatingPortal>
      )}
    </>
  )
}
