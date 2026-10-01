import { ChevronDown } from 'lucide-react'
import { Fragment, type ReactNode, useCallback, useEffect, useId, useRef, useState } from 'react'

import { cn } from '@/lib/cn'
import {
  computeDropdownPosition,
  edgeOption,
  type SelectGroupInfo,
  type SelectOption,
  stepOption,
  typeaheadMatch,
} from '@/lib/select'
import { FloatingPortal } from '@/ui/floating/FloatingPortal'
import { useAnchoredPosition } from '@/ui/floating/use-anchored-position'
import { useDropdownDismiss } from '@/ui/floating/use-dropdown-dismiss'

import { GroupHeader, PlainOption, RichOption } from './SelectOptions'

interface SelectProps<T extends string> {
  value: T
  options: SelectOption<T>[]
  onChange: (value: T) => void
  label: string
  id?: string
  disabled?: boolean
  tone?: 'surface' | 'surface-2'
  size?: 'sm' | 'md'
  className?: string
  /**
   * Rich list: options with the same `group` go under this header (separated by a line), with a radio,
   * badge and right column instead of the check mark.
   */
  groups?: Record<string, SelectGroupInfo>
  /** Shown under the options (not an option). */
  footer?: ReactNode
  /** Trigger content instead of the selected option's label. */
  renderValue?: (option: SelectOption<T> | undefined) => ReactNode
  /** Fixed width of the list (default: at least the trigger, at most 340 px). */
  menuWidth?: number
  /** `end`: the list's right edge lines up with the trigger's. */
  menuAlign?: 'start' | 'end'
}

const TYPEAHEAD_RESET_MS = 600

/**
 * Select-only combobox (WAI-ARIA): focus stays on the trigger, the options are a listbox in a
 * portal pointed at by `aria-activedescendant`. Styled like our inputs and context menus instead of
 * the native popup.
 */
export function Select<T extends string>({
  value,
  options,
  onChange,
  label,
  id,
  disabled,
  tone = 'surface',
  size = 'md',
  className = '',
  groups: groupInfo,
  footer,
  renderValue,
  menuWidth,
  menuAlign = 'start',
}: SelectProps<T>) {
  const baseId = useId()
  const listId = `${baseId}-list`
  const optionId = (index: number) => `${baseId}-opt-${index}`
  const triggerRef = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(-1)
  const [minWidth, setMinWidth] = useState(0)
  const typeahead = useRef({ query: '', at: 0 })

  const selectedIndex = options.findIndex((o) => o.value === value)
  const selected = options[selectedIndex]

  const openMenu = useCallback(
    (index?: number) => {
      if (disabled) return
      setActive(index ?? (selectedIndex >= 0 ? selectedIndex : edgeOption(options, 'first')))
      setMinWidth(triggerRef.current?.getBoundingClientRect().width ?? 0)
      setOpen(true)
    },
    [disabled, options, selectedIndex],
  )

  const close = useCallback(() => {
    setOpen(false)
    typeahead.current.query = ''
  }, [])

  const choose = (index: number) => {
    const option = options[index]
    if (!option || option.disabled) return
    close()
    if (option.value !== value) onChange(option.value)
  }

  const { ref: listRef, position } = useAnchoredPosition((list, viewport) => {
    const rect = triggerRef.current?.getBoundingClientRect() ?? new DOMRect()
    const menu = { width: list.offsetWidth, height: list.scrollHeight }
    const left = menuAlign === 'end' ? rect.right - menu.width : rect.left
    return computeDropdownPosition(
      { left, top: rect.top, width: rect.width, height: rect.height },
      menu,
      viewport,
    )
  }, open)
  useDropdownDismiss(open, triggerRef, listRef, close)

  useEffect(() => {
    if (!open || active < 0 || !position) return
    document.getElementById(`${baseId}-opt-${active}`)?.scrollIntoView({ block: 'nearest' })
  }, [open, active, position, baseId])

  const runTypeahead = (char: string): boolean => {
    const now = Date.now()
    const state = typeahead.current
    state.query = now - state.at > TYPEAHEAD_RESET_MS ? char : state.query + char
    state.at = now
    const from = open ? active : selectedIndex
    const match = typeaheadMatch(options, state.query, from)
    if (match < 0) return false
    if (open) setActive(match)
    else openMenu(match)
    return true
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (disabled) return
    const key = event.key
    const typing = key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey
    const midTypeahead = Date.now() - typeahead.current.at <= TYPEAHEAD_RESET_MS && typeahead.current.query
    if (!open) {
      if (key === 'ArrowDown' || key === 'ArrowUp' || key === 'Enter' || key === ' ') {
        event.preventDefault()
        openMenu()
      } else if (key === 'Home' || key === 'End') {
        event.preventDefault()
        openMenu(edgeOption(options, key === 'Home' ? 'first' : 'last'))
      } else if (typing) {
        event.preventDefault()
        runTypeahead(key)
      }
      return
    }
    switch (key) {
      case 'ArrowDown':
      case 'ArrowUp':
        event.preventDefault()
        if (event.altKey) choose(active)
        else setActive(stepOption(options, active, key === 'ArrowDown' ? 1 : -1))
        return
      case 'Home':
      case 'End':
      case 'PageUp':
      case 'PageDown':
        event.preventDefault()
        setActive(edgeOption(options, key === 'Home' || key === 'PageUp' ? 'first' : 'last'))
        return
      case 'Enter':
        event.preventDefault()
        choose(active)
        return
      case ' ':
        event.preventDefault()
        if (midTypeahead) runTypeahead(' ')
        else choose(active)
        return
      case 'Escape':
        event.preventDefault()
        event.stopPropagation()
        close()
        return
      case 'Tab':
        choose(active)
        return
    }
    if (typing) {
      event.preventDefault()
      runTypeahead(key)
    }
  }

  const small = size === 'sm'
  let previousGroup: string | undefined
  const groups: Array<{
    group: string | undefined
    items: Array<{ option: SelectOption<T>; index: number }>
  }> = []
  options.forEach((option, index) => {
    if (groups.length === 0 || option.group !== previousGroup) groups.push({ group: option.group, items: [] })
    groups.at(-1)?.items.push({ option, index })
    previousGroup = option.group
  })

  const optionProps = (option: SelectOption<T>, index: number) => ({
    option,
    id: optionId(index),
    selected: index === selectedIndex,
    onHover: () => !option.disabled && active !== index && setActive(index),
    onPick: () => choose(index),
  })
  const renderOption = ({ option, index }: { option: SelectOption<T>; index: number }) => (
    <PlainOption key={option.value} {...optionProps(option, index)} highlighted={index === active} />
  )
  const renderRichOption = ({ option, index }: { option: SelectOption<T>; index: number }) => (
    <RichOption
      key={option.value}
      {...optionProps(option, index)}
      highlighted={index === active && !option.disabled}
    />
  )

  const menu = open ? (
    <FloatingPortal
      ref={listRef}
      position={position}
      id={listId}
      role="listbox"
      aria-label={label}
      tabIndex={-1}
      data-menu
      onMouseDown={(e) => e.preventDefault()}
      className={cn(
        'scroll-slim z-dropdown flex flex-col gap-px overflow-y-auto overscroll-contain rounded-[10px] border border-border bg-surface-2 shadow-[0_10px_30px_rgba(0,0,0,0.18)] outline-none dark:shadow-[0_10px_30px_rgba(0,0,0,0.5)]',
        menuWidth ? 'p-1.5' : 'w-max max-w-[340px] p-[5px]',
      )}
      style={menuWidth ? { width: menuWidth } : { minWidth }}
    >
      {groups.map(({ group, items }, i) =>
        group && groupInfo?.[group] ? (
          <div
            key={`group-${i}`}
            role="group"
            aria-labelledby={`${baseId}-group-${i}`}
            className={cn('flex flex-col gap-0.5 py-2', i > 0 && 'border-t border-border')}
          >
            <GroupHeader info={groupInfo[group]} id={`${baseId}-group-${i}`} />
            {items.map(renderRichOption)}
          </div>
        ) : group ? (
          <div key={`group-${i}`} role="group" aria-labelledby={`${baseId}-group-${i}`}>
            <div
              id={`${baseId}-group-${i}`}
              className={cn(
                'px-[9px] pb-1 text-2xs font-semibold tracking-[0.04em] text-fg-muted uppercase',
                i > 0 ? 'pt-2' : 'pt-1',
              )}
            >
              {group}
            </div>
            {items.map(renderOption)}
          </div>
        ) : (
          <Fragment key={`group-${i}`}>{items.map(renderOption)}</Fragment>
        ),
      )}
      {footer && <div className="border-t border-border px-2.5 pt-2 pb-1.5">{footer}</div>}
    </FloatingPortal>
  ) : null

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
        aria-activedescendant={open && active >= 0 ? optionId(active) : undefined}
        disabled={disabled}
        onClick={() => (open ? close() : openMenu())}
        onKeyDown={onKeyDown}
        onBlur={close}
        className={cn(
          'flex w-full items-center gap-2 border text-left text-fg outline-none disabled:opacity-70',
          open ? 'border-accent' : 'border-border focus-visible:border-accent',
          small ? 'h-[25px] rounded-md pr-2 pl-2.5 text-sm' : 'h-[34px] rounded-[7px] pr-2.5 pl-3 text-base',
          tone === 'surface' ? 'bg-surface' : 'bg-surface-2',
          className,
        )}
      >
        {renderValue ? (
          <span className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden">
            {renderValue(selected)}
          </span>
        ) : (
          <span className="min-w-0 flex-1 truncate">{selected?.label ?? ''}</span>
        )}
        <ChevronDown
          size={12}
          aria-hidden
          className={cn(
            'shrink-0 text-fg-muted transition-transform motion-reduce:transition-none',
            open && 'rotate-180',
          )}
        />
      </button>
      {menu}
    </>
  )
}
