import { type Board, BOARD_USER, type Bot } from '@milibot/shared'
import { ChevronDown, Search, Tag as TagIcon, User, Users, X } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { activeFilterCount, type CardFilters } from '@/features/boards/lib/boards'
import { BotAvatar } from '@/features/bots/avatar/BotAvatar'
import { useAppStore } from '@/features/workspace/store'
import { cn } from '@/lib/cn'
import { Popover } from '@/ui/Popover'

import { LabelChip, PickerRow, UserAvatar } from './CardPeople'

const CONTROL =
  'focus-ring hit flex h-9 shrink-0 items-center gap-1.5 rounded-lg border px-3 text-base whitespace-nowrap'

/** Narrows the board to cards matching a text, assignees, labels or the user's own. */
export function BoardFilters({
  board,
  filters,
  onChange,
}: {
  board: Board
  filters: CardFilters
  onChange: (filters: CardFilters) => void
}) {
  const { t } = useTranslation()
  const bots = useAppStore((s) => s.bots)
  const count = activeFilterCount(filters)
  const people: Array<{ id: string; name: string; bot: Bot | null }> = [
    { id: BOARD_USER, name: t('boards.card.you'), bot: null },
    ...Object.values(bots)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((bot) => ({ id: bot.id, name: bot.name, bot })),
  ]
  const toggle = (list: string[], id: string) =>
    list.includes(id) ? list.filter((v) => v !== id) : [...list, id]

  return (
    <div role="search" aria-label={t('boards.filters.label')} className="flex flex-wrap items-center gap-2">
      <label className="relative flex h-9 w-[200px] items-center">
        <Search size={15} className="pointer-events-none absolute left-3 text-fg-secondary" aria-hidden />
        <input
          type="search"
          value={filters.text}
          placeholder={t('boards.filters.text')}
          aria-label={t('boards.filters.text')}
          onChange={(e) => onChange({ ...filters, text: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === 'Escape' && filters.text) {
              e.stopPropagation()
              onChange({ ...filters, text: '' })
            }
          }}
          className={cn(
            'selectable h-9 w-full rounded-lg border bg-surface-2 pr-2 pl-9 text-base text-fg outline-none placeholder:text-fg-secondary focus:border-accent',
            filters.text.trim() ? 'border-accent/60' : 'border-border',
          )}
        />
      </label>
      <FilterMenu
        label={t('boards.filters.assignee')}
        icon={<Users size={15} aria-hidden />}
        picked={filters.assignees.length}
      >
        {people.map((person) => (
          <PickerRow
            key={person.id}
            checked={filters.assignees.includes(person.id)}
            onToggle={() => onChange({ ...filters, assignees: toggle(filters.assignees, person.id) })}
          >
            {person.bot ? (
              <BotAvatar avatar={person.bot.avatar} state={person.bot.status} size={20} animated={false} />
            ) : (
              <UserAvatar size={20} />
            )}
            <span className="truncate">{person.name}</span>
          </PickerRow>
        ))}
      </FilterMenu>
      <FilterMenu
        label={t('boards.filters.labels')}
        icon={<TagIcon size={15} aria-hidden />}
        picked={filters.labels.length}
      >
        {board.labels.length === 0 && (
          <p className="px-2 py-1.5 text-sm text-fg-secondary">{t('boards.filters.noLabels')}</p>
        )}
        {board.labels.map((label) => (
          <PickerRow
            key={label.id}
            checked={filters.labels.includes(label.id)}
            onToggle={() => onChange({ ...filters, labels: toggle(filters.labels, label.id) })}
          >
            <LabelChip label={label} />
          </PickerRow>
        ))}
      </FilterMenu>
      <button
        type="button"
        aria-pressed={filters.mine}
        onClick={() => onChange({ ...filters, mine: !filters.mine })}
        className={cn(
          CONTROL,
          filters.mine
            ? 'border-accent/60 bg-accent-soft font-semibold text-accent-strong'
            : 'border-transparent text-fg-secondary hover:bg-surface-3 hover:text-fg',
        )}
      >
        <User size={15} aria-hidden />
        {t('boards.filters.mine')}
      </button>
      {count > 0 && (
        <button
          type="button"
          onClick={() => onChange({ text: '', assignees: [], labels: [], mine: false })}
          className="focus-ring hit flex h-9 items-center gap-1.5 rounded-lg px-2 text-sm text-fg-secondary hover:bg-surface-3 hover:text-fg"
        >
          <X size={14} aria-hidden />
          {t('boards.filters.clear')}
          <span className="sr-only">({t('boards.filters.active', { count })})</span>
        </button>
      )}
    </div>
  )
}

function FilterMenu({
  label,
  icon,
  picked,
  children,
}: {
  label: string
  icon: ReactNode
  picked: number
  children: ReactNode
}) {
  const [open, setOpen] = useState<{ rect: DOMRect; trigger: HTMLButtonElement } | null>(null)
  return (
    <>
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open !== null}
        onClick={(e) =>
          setOpen(open ? null : { rect: e.currentTarget.getBoundingClientRect(), trigger: e.currentTarget })
        }
        className={cn(
          CONTROL,
          picked
            ? 'border-accent/60 bg-accent-soft font-semibold text-accent-strong'
            : 'border-border bg-surface-2 text-fg hover:bg-surface-3',
        )}
      >
        {icon}
        {label}
        {picked > 0 && (
          <span className="flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-accent-strong px-1 text-2xs font-bold text-on-accent tabular-nums">
            {picked}
          </span>
        )}
        <ChevronDown size={14} aria-hidden />
      </button>
      {open && (
        <Popover anchor={open.rect} trigger={open.trigger} onClose={() => setOpen(null)} label={label} menu>
          <div
            role="menu"
            aria-label={label}
            className="scroll-slim flex max-h-[320px] w-[230px] flex-col overflow-y-auto"
          >
            {children}
          </div>
        </Popover>
      )}
    </>
  )
}
