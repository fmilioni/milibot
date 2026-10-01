import { localDate } from '@milibot/shared'
import { CalendarDays, ChevronLeft, ChevronRight, X } from 'lucide-react'
import { type KeyboardEvent, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { useNow } from '@/hooks/use-now'
import { addDays, addMonths, formatDueDate, monthGrid, parseIsoDay, weekStart } from '@/lib/calendar'
import { cn } from '@/lib/cn'

import { Popover } from './Popover'

const MOVES: Record<string, (day: string) => string> = {
  ArrowLeft: (d) => addDays(d, -1),
  ArrowRight: (d) => addDays(d, 1),
  ArrowUp: (d) => addDays(d, -7),
  ArrowDown: (d) => addDays(d, 7),
  PageUp: (d) => addMonths(d, -1),
  PageDown: (d) => addMonths(d, 1),
}

/** A day (`YYYY-MM-DD`) picked from a calendar in the app's language; null = no date. */
export function DatePicker({
  value,
  onChange,
  label,
  placeholder,
  className = '',
  size = 'md',
}: {
  value: string | null
  onChange: (value: string | null) => void
  label: string
  placeholder?: string
  className?: string
  size?: 'sm' | 'md'
}) {
  const { t, i18n } = useTranslation()
  const [open, setOpen] = useState<{ anchor: DOMRect; trigger: HTMLButtonElement } | null>(null)
  const today = localDate(useNow(60_000))
  const pick = (day: string | null) => {
    onChange(day)
    setOpen(null)
    open?.trigger.focus()
  }
  return (
    <>
      <button
        type="button"
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={open !== null}
        onClick={(e) =>
          setOpen(open ? null : { anchor: e.currentTarget.getBoundingClientRect(), trigger: e.currentTarget })
        }
        className={cn(
          'focus-ring flex items-center gap-2 rounded-lg border border-border bg-surface px-2.5 text-left text-fg hover:bg-surface-2',
          size === 'sm' ? 'h-[27px] text-sm' : 'h-[34px] text-base',
          className,
        )}
      >
        <CalendarDays size={size === 'sm' ? 13 : 14} className="shrink-0 text-fg-muted" aria-hidden />
        <span className={cn('min-w-0 flex-1 truncate', !value && 'text-fg-muted')}>
          {value ? formatDueDate(value, i18n.language, today) : (placeholder ?? t('datePicker.none'))}
        </span>
      </button>
      {open && (
        <Popover anchor={open.anchor} onClose={() => setOpen(null)} trigger={open.trigger} label={label} menu>
          <Calendar value={value} today={today} locale={i18n.language} onPick={pick} />
        </Popover>
      )}
    </>
  )
}

function Calendar({
  value,
  today,
  locale,
  onPick,
}: {
  value: string | null
  today: string
  locale: string
  onPick: (day: string | null) => void
}) {
  const { t } = useTranslation()
  const [focus, setFocus] = useState(value && parseIsoDay(value) ? value : today)
  const grid = useRef<HTMLDivElement>(null)
  const { year, month } = parseIsoDay(focus) ?? { year: 2000, month: 0 }
  const firstDay = weekStart(locale)
  const days = monthGrid(year, month, firstDay)
  const title = new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric' }).format(
    new Date(year, month, 1),
  )
  const weekdays = Array.from({ length: 7 }, (_, i) =>
    new Intl.DateTimeFormat(locale, { weekday: 'narrow' }).format(new Date(2024, 0, 7 + firstDay + i)),
  )
  const long = new Intl.DateTimeFormat(locale, { dateStyle: 'full' })

  useEffect(() => {
    grid.current?.querySelector<HTMLButtonElement>(`[data-day="${focus}"]`)?.focus()
  }, [focus])

  const onKeyDown = (e: KeyboardEvent) => {
    const move = MOVES[e.key]
    if (move) {
      e.preventDefault()
      setFocus(move(focus))
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault()
      const offset = (new Date(`${focus}T00:00`).getDay() - firstDay + 7) % 7
      setFocus(addDays(focus, e.key === 'Home' ? -offset : 6 - offset))
    }
  }

  const navButton = (delta: number, Icon: typeof ChevronLeft, text: string) => (
    <button
      type="button"
      aria-label={text}
      onClick={() => setFocus(addMonths(focus, delta))}
      className="focus-ring flex size-7 items-center justify-center rounded-md text-fg-secondary hover:bg-surface-3"
    >
      <Icon size={14} />
    </button>
  )

  return (
    <div className="flex w-[252px] flex-col gap-2 p-1.5">
      <div className="flex items-center gap-1">
        <span
          className="flex-1 pl-1 text-base font-semibold text-fg first-letter:uppercase"
          aria-live="polite"
        >
          {title}
        </span>
        {navButton(-1, ChevronLeft, t('datePicker.previousMonth'))}
        {navButton(1, ChevronRight, t('datePicker.nextMonth'))}
      </div>
      <div
        ref={grid}
        role="grid"
        aria-label={title}
        onKeyDown={onKeyDown}
        className="grid grid-cols-7 gap-0.5"
      >
        {weekdays.map((day, i) => (
          <span
            key={i}
            role="columnheader"
            className="flex h-6 items-center justify-center text-xs font-medium text-fg-muted uppercase"
          >
            {day}
          </span>
        ))}
        {days.map((day) => {
          const inMonth = parseIsoDay(day)?.month === month
          const selected = day === value
          const isToday = day === today
          return (
            <button
              key={day}
              type="button"
              role="gridcell"
              data-day={day}
              tabIndex={day === focus ? 0 : -1}
              aria-selected={selected}
              aria-current={isToday ? 'date' : undefined}
              aria-label={long.format(new Date(`${day}T00:00`))}
              onClick={() => onPick(day)}
              className={cn(
                'focus-ring flex size-8 items-center justify-center rounded-md text-sm tabular-nums',
                selected
                  ? 'bg-accent font-semibold text-on-accent'
                  : isToday
                    ? 'font-semibold text-accent ring-1 ring-accent/50 ring-inset hover:bg-surface-3'
                    : inMonth
                      ? 'text-fg hover:bg-surface-3'
                      : 'text-fg-muted/60 hover:bg-surface-3',
              )}
            >
              {Number(day.slice(8))}
            </button>
          )
        })}
      </div>
      <div className="flex items-center justify-between border-t border-border pt-1.5">
        <button
          type="button"
          disabled={!value}
          onClick={() => onPick(null)}
          className="focus-ring flex items-center gap-1 rounded px-1 text-sm text-fg-secondary hover:text-fg disabled:opacity-40"
        >
          <X size={12} />
          {t('datePicker.clear')}
        </button>
        <button
          type="button"
          onClick={() => onPick(today)}
          className="focus-ring rounded px-1 text-sm font-medium text-accent hover:underline"
        >
          {t('datePicker.today')}
        </button>
      </div>
    </div>
  )
}
