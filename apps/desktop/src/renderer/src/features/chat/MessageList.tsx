import type { Bot } from '@milibot/shared'
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso'

import { BotAvatar } from '@/features/bots/avatar/BotAvatar'
import { type StatusDetail, waitingForUser } from '@/features/bots/lib/bot-status'
import { useDebouncedWorking } from '@/features/chat/hooks/use-debounced-working'
import { useRevealingMessages } from '@/features/chat/hooks/use-text-reveal'
import { useWorkInput } from '@/features/chat/hooks/use-work-input'
import { buildChatItems, type ChatItem } from '@/features/chat/lib/chat-items'
import { pausedWaiting, workingCandidates } from '@/features/chat/lib/working'
import { useAppStore } from '@/features/workspace/store'
import { useReducedMotion } from '@/features/workspace/use-reduced-motion'
import { cn } from '@/lib/cn'
import { formatDay } from '@/lib/format'
import type { MentionTarget } from '@/lib/mentions'
import { AreaError, ErrorBoundary } from '@/ui/ErrorBoundary'

import { type InternalLayout, MessageRow } from './MessageRow'
import { UnreadDivider } from './SystemLine'
import { InternalWorkingRow, PausedRow, WorkingRow } from './WorkingRow'

/** Large base so older pages can be prepended with a decreasing `firstItemIndex`. */
const START_INDEX = 1_000_000
/** A bot busy without an optimistic trigger shows its row only after this, so turn ends never flash it. */
const WORKING_ROW_DELAY_MS = 500
const STICK_THRESHOLD_PX = 120

/** Centered reading column; the chat background stays full width. */
export const CHAT_COLUMN = 'mx-auto w-full max-w-[800px]'

/** Keeps the first rendered message at the same Virtuoso index when older pages are prepended. */
interface Anchor {
  items: ChatItem[]
  key: string | null
  index: number
  first: number
}

function anchorFor(items: ChatItem[], previous: Anchor | null): Anchor {
  const firstMessage = items.findIndex((i) => i.kind === 'message')
  let first = START_INDEX
  if (previous?.key != null) {
    const key = previous.key
    const now = items.findIndex((i) => i.key === key)
    first = now >= 0 ? previous.first - (now - previous.index) : previous.first
  }
  return { items, key: items[firstMessage]?.key ?? null, index: firstMessage, first }
}

interface ListContext {
  loadingOlder: string
}

function ListHeader({ context }: { context?: ListContext }) {
  return <div className="h-5 pt-1 text-center text-xs text-fg-muted">{context?.loadingOlder}</div>
}

function ListFooter() {
  return <div className="h-5" />
}

const LIST_COMPONENTS = { Header: ListHeader, Footer: ListFooter }

interface MessageListProps {
  conversationId: string
  bots: Record<string, Bot>
  emptyName: string
  emptyBot: Bot | null
  showRoleChips: boolean
  internal?: InternalLayout
  /** A session's conversation: its lane's status drives the working row (not the bot's, which may be a chat's). */
  sessionLane?: { status: string; detail: StatusDetail | undefined }
}

export function MessageList({
  conversationId,
  bots,
  emptyName,
  emptyBot,
  showRoleChips,
  internal,
  sessionLane,
}: MessageListProps) {
  const { t } = useTranslation()
  const thread = useAppStore((s) => s.threads[conversationId])
  const conversation = useAppStore((s) => s.conversations[conversationId])
  const loadOlder = useAppStore((s) => s.loadOlderMessages)
  const reduced = useReducedMotion()
  const revealing = useRevealingMessages()
  const messages = useMemo(() => thread?.items ?? [], [thread?.items])
  const workInput = useWorkInput(conversationId, sessionLane)
  const candidates = useMemo(
    () =>
      workInput ? workingCandidates({ ...workInput, messages, isRevealing: (id) => revealing.has(id) }) : [],
    [workInput, messages, revealing],
  )
  const statusDetail = useAppStore((s) => s.statusDetail)
  // A bot waiting on a question/password card: the card is the prompt, not a "Working…" row.
  const workingIds = useDebouncedWorking(candidates, WORKING_ROW_DELAY_MS)
    .filter((id) =>
      sessionLane
        ? !waitingForUser(sessionLane.status, sessionLane.detail)
        : !waitingForUser(bots[id]?.status, statusDetail[id]),
    )
    .join(' ')
  const pausedIds = useMemo(
    () => (conversation && !internal ? pausedWaiting(conversation, bots, messages) : []).join(' '),
    [conversation, internal, bots, messages],
  )
  const items = useMemo(() => {
    const rows = buildChatItems(messages, thread?.unreadAtOpen ?? 0)
    for (const botId of workingIds ? workingIds.split(' ') : []) {
      rows.push({ kind: 'working', key: `working-${botId}`, botId })
    }
    for (const botId of pausedIds ? pausedIds.split(' ') : []) {
      rows.push({ kind: 'paused', key: `paused-${botId}`, botId })
    }
    return rows
  }, [messages, thread?.unreadAtOpen, workingIds, pausedIds])
  const liveStatus = workingIds
    ? workingIds
        .split(' ')
        .map((id) => t('chat.workingAnnouncement', { name: bots[id]?.name ?? '' }))
        .join(' ')
    : ''
  const mentions = useMemo<MentionTarget[]>(
    () => Object.values(bots).map((b) => ({ id: b.id, name: b.name })),
    [bots],
  )

  const [anchor, setAnchor] = useState(() => anchorFor(items, null))
  let currentAnchor = anchor
  if (anchor.items !== items) {
    currentAnchor = anchorFor(items, anchor)
    setAnchor(currentAnchor)
  }
  const firstItemIndex = currentAnchor.first

  // Stay pinned to the newest message when the window or panels resize.
  const virtuoso = useRef<VirtuosoHandle>(null)
  const atBottom = useRef(true)
  const onAtBottom = useCallback((value: boolean) => {
    atBottom.current = value
  }, [])
  const [scroller, setScroller] = useState<HTMLElement | null>(null)
  useEffect(() => {
    if (!scroller) return
    const observer = new ResizeObserver(() => {
      if (atBottom.current) virtuoso.current?.scrollToIndex({ index: 'LAST', align: 'end' })
    })
    observer.observe(scroller)
    return () => observer.disconnect()
  }, [scroller])

  const hasMore = thread?.hasMore
  const loading = thread?.loading
  const onStartReached = useCallback(() => {
    if (hasMore && !loading) void loadOlder(conversationId)
  }, [hasMore, loading, loadOlder, conversationId])

  // Rows that grow in place (text typing out) do not append items, so Virtuoso does not follow them.
  // Stick to the bottom while the reader was there before the growth; any scroll re-evaluates it.
  const stick = useRef(true)
  useEffect(() => {
    if (!scroller) return
    stick.current = true
    const onScroll = () => {
      stick.current = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < STICK_THRESHOLD_PX
    }
    scroller.addEventListener('scroll', onScroll, { passive: true })
    return () => scroller.removeEventListener('scroll', onScroll)
  }, [scroller])
  const onHeightChanged = useCallback(() => {
    if (stick.current && scroller) scroller.scrollTo({ top: scroller.scrollHeight })
  }, [scroller])

  const lastItem = items[items.length - 1]
  const lastIsOwn = lastItem?.kind === 'message' && lastItem.message.authorType === 'user'
  const context = useMemo<ListContext>(
    () => ({ loadingOlder: loading && hasMore ? t('chat.loadingOlder') : '' }),
    [loading, hasMore, t],
  )

  const liveRegion = (
    <div className="sr-only" role="status" aria-live="polite">
      {liveStatus}
    </div>
  )

  if (thread?.error && items.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 px-10 text-center">
        <div className="text-base text-fg-muted">{t('chat.loadFailed')}</div>
        <button
          type="button"
          onClick={() => useAppStore.getState().reloadConversation(conversationId)}
          className="focus-ring cursor-pointer rounded text-base font-semibold text-accent hover:underline"
        >
          {t('chat.retryLoad')}
        </button>
      </div>
    )
  }

  if (thread?.loaded && !thread.loading && items.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 px-10 text-center">
        {liveRegion}
        {emptyBot && <BotAvatar avatar={emptyBot.avatar} state={emptyBot.status} size={56} />}
        <div className="text-lg font-semibold text-fg">{t('chat.emptyTitle', { name: emptyName })}</div>
        <div className="max-w-sm text-base text-fg-muted">{t('chat.emptyHint')}</div>
      </div>
    )
  }

  if (items.length === 0) return <div className="flex-1">{liveRegion}</div>

  return (
    <>
      {liveRegion}
      <Virtuoso<ChatItem, ListContext>
        key={conversationId}
        ref={virtuoso}
        scrollerRef={(el) => setScroller(el instanceof HTMLElement ? el : null)}
        atBottomStateChange={onAtBottom}
        className="scroll-slim min-h-0 flex-1"
        data={items}
        firstItemIndex={firstItemIndex}
        initialTopMostItemIndex={items.length - 1}
        alignToBottom
        followOutput={(atBottom) => (atBottom || lastIsOwn ? 'auto' : false)}
        atBottomThreshold={STICK_THRESHOLD_PX}
        totalListHeightChanged={onHeightChanged}
        startReached={onStartReached}
        increaseViewportBy={{ top: 600, bottom: 200 }}
        computeItemKey={(_, item) => item.key}
        context={context}
        components={LIST_COMPONENTS}
        itemContent={(_, item) => (
          <ChatRow
            item={item}
            bots={bots}
            mentions={mentions}
            showRoleChips={showRoleChips}
            reduced={reduced}
            internal={internal}
          />
        )}
      />
    </>
  )
}

const ChatRow = memo(function ChatRow({
  item,
  bots,
  mentions,
  showRoleChips,
  reduced,
  internal,
}: {
  item: ChatItem
  bots: Record<string, Bot>
  mentions: MentionTarget[]
  showRoleChips: boolean
  reduced: boolean
  internal: InternalLayout | undefined
}) {
  const { t, i18n } = useTranslation()
  let content: React.ReactNode
  if (item.kind === 'paused') {
    const bot = bots[item.botId]
    content = bot ? <PausedRow bot={bot} /> : null
  } else if (item.kind === 'working') {
    const bot = bots[item.botId]
    content = !bot ? null : internal ? (
      <InternalWorkingRow bot={bot} right={bot.id === internal.rightBotId} bots={bots} />
    ) : (
      <WorkingRow bot={bot} showName={showRoleChips} reduced={reduced} />
    )
  } else if (item.kind === 'day') {
    content = (
      <div className="flex justify-center text-xs font-semibold text-fg-muted" role="separator">
        {formatDay(item.at, i18n.language, t)}
      </div>
    )
  } else if (item.kind === 'unread') {
    content = <UnreadDivider />
  } else {
    content = (
      <ErrorBoundary
        area="message"
        resetKey={item.message}
        fallback={(retry) => <AreaError inline message={t('app.messageError')} onRetry={retry} />}
      >
        <MessageRow
          message={item.message}
          continued={item.continued}
          bots={bots}
          mentions={mentions}
          showRoleChips={showRoleChips}
          reduced={reduced}
          internal={internal}
        />
      </ErrorBoundary>
    )
  }
  const gap = item.kind === 'message' && item.continued ? 'pt-1.5' : internal ? 'pt-4' : 'pt-[18px]'
  return (
    <div className={cn(internal ? 'px-5' : 'px-7', gap)}>
      <div className={CHAT_COLUMN}>{content}</div>
    </div>
  )
})
