import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import type { Bot, ConversationSummary } from '@milibot/shared'
import { Star } from 'lucide-react'
import { type CSSProperties, type KeyboardEvent, memo, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { BotAvatar } from '@/features/bots/avatar/BotAvatar'
import { GroupAvatar } from '@/features/bots/avatar/GroupAvatar'
import { botStatusLabel, waitingForUser } from '@/features/bots/lib/bot-status'
import { describeConversation, STATUS_TEXT_CLASS } from '@/features/chat/lib/conversation'
import { messagePreview } from '@/features/chat/lib/message-preview'
import { isNavScreen, useAppStore } from '@/features/workspace/store'
import { cn } from '@/lib/cn'
import { formatListTime } from '@/lib/format'

import { ConversationMenu } from './ConversationMenu'

interface SidebarItemProps {
  conversation: ConversationSummary
  bots: Record<string, Bot>
  containerKey: string
}

function usePreview(conversation: ConversationSummary, bots: Record<string, Bot>) {
  const { t } = useTranslation()
  const display = describeConversation(conversation, bots, t('sidebar.groupFallback'))
  const busy = display.primaryBot ?? display.members.find((m) => m.status !== 'idle') ?? null
  const detail = useAppStore((s) => (busy ? s.statusDetail[busy.id] : undefined))
  const last = conversation.lastMessage
  if (busy && busy.status !== 'idle') {
    const text = botStatusLabel(busy.status, detail, t, bots)
    const waiting = waitingForUser(busy.status, detail) !== null
    return {
      display,
      text: display.primaryBot ? text : `${busy.name}: ${text}`,
      className: waiting ? 'text-warning' : (STATUS_TEXT_CLASS[busy.status] ?? 'text-fg-muted'),
      waiting,
    }
  }
  if (last) {
    const text = messagePreview(last, t, bots)
    const author = last.authorBotId ? bots[last.authorBotId] : undefined
    const prefixed =
      last.authorType === 'user'
        ? t('sidebar.youPrefix', { text })
        : conversation.type === 'group' && author
          ? t('sidebar.authorPrefix', { name: author.name, text })
          : text
    return { display, text: prefixed || t('sidebar.noMessages'), className: 'text-fg-muted', waiting: false }
  }
  return { display, text: t('sidebar.noMessages'), className: 'text-fg-muted', waiting: false }
}

export const SidebarItem = memo(function SidebarItem({ conversation, bots, containerKey }: SidebarItemProps) {
  const { t, i18n } = useTranslation()
  const selected = useAppStore((s) => s.selectedConversationId === conversation.id && !isNavScreen(s.screen))
  const renaming = useAppStore((s) => s.renamingConversationId === conversation.id)
  const select = useAppStore((s) => s.selectConversation)
  const setRenaming = useAppStore((s) => s.setRenaming)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: conversation.id,
    data: { containerKey, type: 'item' },
  })
  const { display, text, className, waiting } = usePreview(conversation, bots)
  const unread = selected ? 0 : conversation.sidebar.unreadCount
  const time = conversation.lastMessageAt ?? conversation.createdAt

  const style: CSSProperties = {
    transform: CSS.Translate.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : undefined,
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (renaming) return
    if (event.key === 'F2') {
      event.preventDefault()
      setRenaming(conversation.id)
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      select(conversation.id)
    } else if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
      event.preventDefault()
      const rect = event.currentTarget.getBoundingClientRect()
      setMenu({ x: rect.left + 200, y: rect.top + 32 })
    }
  }

  return (
    <>
      <div
        ref={setNodeRef}
        style={style}
        {...attributes}
        {...listeners}
        role="button"
        tabIndex={0}
        aria-current={selected || undefined}
        aria-label={display.title}
        data-conversation-id={conversation.id}
        onClick={() => !renaming && select(conversation.id)}
        onKeyDown={onKeyDown}
        onContextMenu={(event) => {
          event.preventDefault()
          setMenu({ x: event.clientX, y: event.clientY })
        }}
        className={cn(
          'focus-inset flex h-[52px] w-full items-center gap-2.5 rounded-[10px] px-2.5 text-left',
          selected || menu ? 'bg-surface-3' : 'hover:bg-surface-3/60',
        )}
      >
        {conversation.type === 'direct' && display.primaryBot ? (
          <BotAvatar
            avatar={display.primaryBot.avatar}
            state={display.primaryBot.status}
            size={36}
            className="shrink-0"
          />
        ) : (
          <GroupAvatar
            members={display.members.map((m) => ({ id: m.id, avatar: m.avatar, state: m.status }))}
            size={36}
          />
        )}
        <div className="flex min-w-0 flex-1 flex-col gap-[3px]">
          <div className="flex h-4 items-center gap-1.5">
            {renaming ? (
              <RenameInput
                conversation={conversation}
                initial={display.title}
                onDone={() => setRenaming(null)}
              />
            ) : (
              <span className="truncate text-base font-semibold text-fg">{display.title}</span>
            )}
            {display.label && !renaming && (
              <span
                className={cn(
                  'shrink-0 rounded-[5px] px-1.5 py-px text-2xs leading-3 text-fg-secondary',
                  selected ? 'bg-surface-2' : 'bg-surface-3',
                )}
              >
                {display.label}
              </span>
            )}
            <span className="flex-1" />
            {conversation.sidebar.pinned && (
              <Star size={11} className="shrink-0 text-warning" aria-label={t('sidebar.pinned')} />
            )}
            <span className="shrink-0 text-2xs text-fg-muted">{formatListTime(time, i18n.language, t)}</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className={`min-w-0 flex-1 truncate text-sm leading-4 ${className}`}>{text}</span>
            {waiting && unread === 0 && (
              <span className="size-2 shrink-0 rounded-full bg-warning" aria-hidden />
            )}
            {unread > 0 && (
              <span
                className="min-w-[19px] shrink-0 rounded-full bg-accent px-1.5 text-center text-2xs leading-[14px] font-semibold text-on-accent"
                aria-label={t('sidebar.unread', { count: unread })}
              >
                {unread > 99 ? '99+' : unread}
              </span>
            )}
          </div>
        </div>
      </div>
      {menu && (
        <ConversationMenu conversation={conversation} x={menu.x} y={menu.y} onClose={() => setMenu(null)} />
      )}
    </>
  )
})

function RenameInput({
  conversation,
  initial,
  onDone,
}: {
  conversation: ConversationSummary
  initial: string
  onDone: () => void
}) {
  const { t } = useTranslation()
  const rename = useAppStore((s) => s.renameConversation)
  const [value, setValue] = useState(initial)
  const ref = useRef<HTMLInputElement>(null)
  const done = useRef(false)

  useEffect(() => {
    ref.current?.focus()
    ref.current?.select()
  }, [])

  const commit = () => {
    if (done.current) return
    done.current = true
    if (value.trim() && value.trim() !== initial) void rename(conversation.id, value)
    onDone()
  }

  return (
    <input
      ref={ref}
      value={value}
      maxLength={conversation.type === 'direct' ? 48 : 64}
      aria-label={t('sidebar.menu.rename')}
      onChange={(e) => setValue(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Enter') commit()
        if (e.key === 'Escape') {
          done.current = true
          onDone()
        }
      }}
      onBlur={commit}
      className="selectable h-5 min-w-0 flex-1 rounded border border-accent bg-surface-2 px-1 text-base font-semibold text-fg outline-none"
    />
  )
}
