import {
  type Board,
  BOARD_LABEL_COLORS,
  BOARD_LIMITS,
  BOARD_USER,
  type BoardLabel,
  type Bot,
  foldText,
} from '@milibot/shared'
import { Check, Plus, Tag as TagIcon, Trash2, User, UserPlus } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { avatarStack } from '@/features/boards/lib/boards'
import { LABEL_COLOR_CLASSES } from '@/features/boards/lib/label-colors'
import { BotAvatar } from '@/features/bots/avatar/BotAvatar'
import { toastOnError, useAppStore } from '@/features/workspace/store'
import { useWorkspaceId } from '@/features/workspace/use-workspace-id'
import { cn } from '@/lib/cn'
import { Popover } from '@/ui/Popover'
import { Tooltip } from '@/ui/Tooltip'

import { useBoardStore } from './store'

export function LabelChip({ label, size = 'sm' }: { label: BoardLabel; size?: 'sm' | 'md' }) {
  return (
    <span
      className={cn(
        'inline-flex max-w-full items-center truncate font-medium',
        size === 'md' ? 'h-8 rounded-md px-2.5 text-base' : 'h-5 rounded-[5px] px-1.5 text-xs',
        LABEL_COLOR_CLASSES[label.color].chip,
      )}
    >
      {label.name}
    </span>
  )
}

/** The user: a person on a round tint; `ring` adds the gap and thin ring that tell it apart from bots. */
export function UserAvatar({ size, ring = false }: { size: number; ring?: boolean }) {
  return (
    <span
      className={cn(
        'flex shrink-0 items-center justify-center rounded-full bg-accent-soft text-accent-strong',
        ring && 'shadow-[0_0_0_2px_var(--surface-2),0_0_0_3.5px_var(--text-muted)]',
      )}
      style={{ width: size, height: size }}
    >
      <User size={Math.round(size * 0.62)} aria-hidden />
    </span>
  )
}

/** Avatars of a card's assignees, overlapping, the first `max` and then "+N"; the user as a person icon. */
export function AssigneeStack({
  assignees,
  size = 18,
  max = 4,
}: {
  assignees: readonly string[]
  size?: number
  max?: number
}) {
  const { t } = useTranslation()
  const bots = useAppStore((s) => s.bots)
  const names = assignees
    .map((a) => (a === BOARD_USER ? t('boards.card.you') : (bots[a]?.name ?? t('boards.card.deletedBot'))))
    .join(', ')
  const { shown, extra } = avatarStack(assignees, max)
  return (
    <Tooltip content={names}>
      <span className="flex shrink-0 items-center" role="img" aria-label={names}>
        {shown.map((a, i) => {
          const bot = bots[a]
          // A round ring only fits the user's round avatar: on a bot's shape it cuts a dark arc into its neighbor.
          return (
            <span key={a} className="flex" style={i ? { marginLeft: -Math.round(size * 0.35) } : undefined}>
              {a === BOARD_USER || !bot ? (
                <span className="flex rounded-full ring-2 ring-surface-2">
                  <UserAvatar size={size} />
                </span>
              ) : (
                <BotAvatar avatar={bot.avatar} state={bot.status} size={size} animated={false} />
              )}
            </span>
          )
        })}
        {extra > 0 && (
          <span className="ml-1 text-xs font-semibold text-fg-secondary tabular-nums">
            {t('boards.moreAssignees', { count: extra })}
          </span>
        )}
      </span>
    </Tooltip>
  )
}

export function PickerRow({
  checked,
  onToggle,
  children,
  actions,
}: {
  checked: boolean
  onToggle: () => void
  children: ReactNode
  actions?: ReactNode
}) {
  return (
    <div className="group flex items-center gap-1 rounded-md hover:bg-surface-3">
      <button
        type="button"
        role="menuitemcheckbox"
        aria-checked={checked}
        onClick={onToggle}
        className="focus-ring flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-left text-base text-fg"
      >
        {children}
        <span className="flex-1" />
        {checked && <Check size={14} className="shrink-0 text-accent" aria-hidden />}
      </button>
      {actions}
    </div>
  )
}

function PickerTrigger({
  label,
  empty,
  icon,
  onOpen,
  children,
}: {
  label: string
  empty: boolean
  icon: ReactNode
  onOpen: (rect: DOMRect, trigger: HTMLButtonElement) => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-haspopup="menu"
      onClick={(e) => onOpen(e.currentTarget.getBoundingClientRect(), e.currentTarget)}
      className={cn(
        'focus-ring flex h-[27px] max-w-full min-w-0 items-center gap-1.5 rounded-lg px-1.5 text-sm hover:bg-surface-3',
        empty ? 'text-fg-muted' : 'text-fg-secondary',
      )}
    >
      {empty && icon}
      {children}
    </button>
  )
}

/** Opens a picker from the trigger a caller draws. */
export type PickerOpener = (trigger: HTMLButtonElement) => void

/** Who is on the card: the user and any bots, toggled from a list; `trigger` draws what opens it. */
export function AssigneePicker({
  value,
  onChange,
  trigger,
}: {
  value: readonly string[]
  onChange: (assignees: string[]) => void
  trigger?: (open: PickerOpener) => ReactNode
}) {
  const { t } = useTranslation()
  const bots = useAppStore((s) => s.bots)
  const [open, setOpen] = useState<{ rect: DOMRect; trigger: HTMLButtonElement } | null>(null)
  const people: Array<{ id: string; name: string; bot: Bot | null }> = [
    { id: BOARD_USER, name: t('boards.card.you'), bot: null },
    ...Object.values(bots)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((bot) => ({ id: bot.id, name: bot.name, bot })),
  ]
  const toggle = (id: string) =>
    onChange(
      value.includes(id) ? value.filter((a) => a !== id) : [...value, id].slice(0, BOARD_LIMITS.assignees),
    )
  const names = value
    .map((a) => people.find((p) => p.id === a)?.name ?? t('boards.card.deletedBot'))
    .join(', ')
  return (
    <>
      {trigger ? (
        trigger((el) => setOpen(open ? null : { rect: el.getBoundingClientRect(), trigger: el }))
      ) : (
        <PickerTrigger
          label={t('boards.card.assignees')}
          empty={value.length === 0}
          icon={<UserPlus size={13} aria-hidden />}
          onOpen={(rect, el) => setOpen(open ? null : { rect, trigger: el })}
        >
          {value.length === 0 ? (
            t('boards.card.assign')
          ) : (
            <>
              <AssigneeStack assignees={value} />
              <span className="min-w-0 truncate">{names}</span>
            </>
          )}
        </PickerTrigger>
      )}
      {open && (
        <Popover
          anchor={open.rect}
          trigger={open.trigger}
          onClose={() => setOpen(null)}
          label={t('boards.card.assignees')}
          menu
        >
          <div role="menu" className="flex w-[220px] flex-col">
            {people.map((person) => (
              <PickerRow
                key={person.id}
                checked={value.includes(person.id)}
                onToggle={() => toggle(person.id)}
              >
                {person.bot ? (
                  <BotAvatar
                    avatar={person.bot.avatar}
                    state={person.bot.status}
                    size={20}
                    animated={false}
                  />
                ) : (
                  <UserAvatar size={20} />
                )}
                <span className="truncate">{person.name}</span>
              </PickerRow>
            ))}
          </div>
        </Popover>
      )}
    </>
  )
}

/** The card's labels, picked from the board's; typing a new name creates one. Colors and deletion live here too. */
export function LabelPicker({
  board,
  value,
  onChange,
  trigger,
}: {
  board: Board
  value: readonly string[]
  onChange: (labelIds: string[]) => void
  trigger?: (open: PickerOpener) => ReactNode
}) {
  const { t } = useTranslation()
  const workspaceId = useWorkspaceId()
  const createLabel = useBoardStore((s) => s.createLabel)
  const updateLabel = useBoardStore((s) => s.updateLabel)
  const deleteLabel = useBoardStore((s) => s.deleteLabel)
  const [open, setOpen] = useState<{ rect: DOMRect; trigger: HTMLButtonElement } | null>(null)
  const [query, setQuery] = useState('')
  const picked = board.labels.filter((l) => value.includes(l.id))
  const key = foldText(query, { trim: true })
  const shown = board.labels.filter((l) => !key || foldText(l.name, { trim: true }).includes(key))
  const exact = board.labels.some((l) => foldText(l.name, { trim: true }) === key)
  const name = query.trim().slice(0, BOARD_LIMITS.labelName)
  const toggle = (id: string) => onChange(value.includes(id) ? value.filter((v) => v !== id) : [...value, id])
  const create = () => {
    if (!name || exact) return
    void toastOnError(
      createLabel(workspaceId, board.id, { name }).then((label) => {
        onChange([...value, label.id])
        setQuery('')
      }),
    )
  }
  const cycleColor = (label: BoardLabel) => {
    const next = BOARD_LABEL_COLORS[(BOARD_LABEL_COLORS.indexOf(label.color) + 1) % BOARD_LABEL_COLORS.length]
    void toastOnError(updateLabel(workspaceId, board.id, label.id, { color: next }))
  }
  const show = (rect: DOMRect, el: HTMLButtonElement) => setOpen(open ? null : { rect, trigger: el })
  return (
    <>
      {trigger ? (
        trigger((el) => show(el.getBoundingClientRect(), el))
      ) : (
        <PickerTrigger
          label={t('boards.card.labels')}
          empty={picked.length === 0}
          icon={<TagIcon size={13} aria-hidden />}
          onOpen={show}
        >
          {picked.length === 0 ? (
            t('boards.card.labels')
          ) : (
            <span className="flex min-w-0 flex-wrap items-center gap-1">
              {picked.map((label) => (
                <LabelChip key={label.id} label={label} />
              ))}
            </span>
          )}
        </PickerTrigger>
      )}
      {open && (
        <Popover
          anchor={open.rect}
          trigger={open.trigger}
          onClose={() => setOpen(null)}
          label={t('boards.card.labels')}
          menu
        >
          <div role="menu" className="flex w-[240px] flex-col gap-1">
            <input
              autoFocus
              value={query}
              maxLength={BOARD_LIMITS.labelName}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== 'Enter') return
                e.preventDefault()
                const only = shown.length === 1 ? shown[0] : undefined
                if (!exact && name) create()
                else if (only) toggle(only.id)
              }}
              placeholder={t('boards.labels.search')}
              aria-label={t('boards.labels.search')}
              className="selectable h-8 rounded-md border border-border bg-surface px-2 text-sm text-fg outline-none placeholder:text-fg-muted focus:border-accent"
            />
            <div className="scroll-slim flex max-h-[260px] flex-col overflow-y-auto">
              {shown.map((label) => (
                <PickerRow
                  key={label.id}
                  checked={value.includes(label.id)}
                  onToggle={() => toggle(label.id)}
                  actions={
                    <span className="flex shrink-0 items-center pr-1 opacity-0 group-focus-within:opacity-100 group-hover:opacity-100">
                      <Tooltip content={t('boards.labels.color')}>
                        <button
                          type="button"
                          aria-label={t('boards.labels.color')}
                          onClick={() => cycleColor(label)}
                          className="focus-ring flex size-6 items-center justify-center rounded"
                        >
                          <span className={`size-3 rounded-full ${LABEL_COLOR_CLASSES[label.color].dot}`} />
                        </button>
                      </Tooltip>
                      <Tooltip content={t('boards.labels.delete')}>
                        <button
                          type="button"
                          aria-label={t('boards.labels.delete')}
                          onClick={() => void toastOnError(deleteLabel(workspaceId, board.id, label.id))}
                          className="focus-ring flex size-6 items-center justify-center rounded text-fg-muted hover:text-danger"
                        >
                          <Trash2 size={12} />
                        </button>
                      </Tooltip>
                    </span>
                  }
                >
                  <LabelChip label={label} />
                </PickerRow>
              ))}
              {name && !exact && (
                <button
                  type="button"
                  onClick={create}
                  className="focus-ring flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-fg-secondary hover:bg-surface-3"
                >
                  <Plus size={13} aria-hidden />
                  {t('boards.labels.create', { name })}
                </button>
              )}
              {!name && board.labels.length === 0 && (
                <p className="px-2 py-1.5 text-sm text-fg-muted">{t('boards.labels.empty')}</p>
              )}
            </div>
          </div>
        </Popover>
      )}
    </>
  )
}
