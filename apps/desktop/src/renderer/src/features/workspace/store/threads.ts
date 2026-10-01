import type { Message } from '@milibot/shared'

import { api } from '@/api/daemon'
import { replyTargets } from '@/features/chat/lib/working'
import {
  appendToThread,
  clearPendingReplies,
  markPendingReplies,
  mergeMessages,
  updateMessage,
} from '@/features/workspace/lib/threads'

import type { AppState } from './types'

const PAGE_SIZE = 50
/** Retry delays of a failed message load while its conversation stays open. */
const LOAD_RETRY_MS = [1000, 2000, 5000, 10_000, 20_000]
/** An optimistic "working" state reverts if the daemon never reports the bot (e.g. no runtime). */
const PENDING_REPLY_TIMEOUT_MS = 30_000

/**
 * The app store's message threads: paged loads with retry, sending, marking read, and the optimistic
 * "working" state of the bots a message asks to reply. Live message events go through
 * `applyWorkspaceEvent`; `afterMessageCreated` runs what a new message sets off.
 */
export function createThreads(
  get: () => AppState,
  set: (patch: Partial<AppState>) => void,
  ws: () => string,
) {
  const loadRetries = new Map<string, { attempt: number; timer: ReturnType<typeof setTimeout> }>()

  const replaceMessage = (message: Message) =>
    set(updateMessage(get(), message.conversationId, message.id, () => message))

  const expirePendingReplies = (botIds: string[], at: number) =>
    setTimeout(() => {
      const cleared = clearPendingReplies(get(), botIds, at)
      if (cleared) set(cleared)
    }, PENDING_REPLY_TIMEOUT_MS)

  const markReadIfVisible = (message: Message) => {
    if (message.conversationId !== get().selectedConversationId || message.authorType === 'user') return
    if (document.visibilityState !== 'visible') return
    void api()
      .call('markConversationRead', {
        params: { workspaceId: ws(), conversationId: message.conversationId },
        body: { lastReadMessageId: message.id },
      })
      .catch(() => undefined)
  }

  /** A message arrived: marked read when on screen; the bots it woke stop looking busy if they never start. */
  const afterMessageCreated = (message: Message, before: AppState['pendingReplies'], at: number) => {
    const woken = Object.entries(get().pendingReplies).flatMap(([botId, pending]) =>
      pending?.at === at && before[botId] !== pending ? [botId] : [],
    )
    if (woken.length) expirePendingReplies(woken, at)
    markReadIfVisible(message)
  }

  const loadLatest = async (conversationId: string) => {
    const workspaceId = get().workspaceId
    if (!workspaceId) return
    const existing = get().threads[conversationId]
    const conversation = get().conversations[conversationId]
    // Internal bot↔bot threads have no sidebar item nor read marker.
    const unreadAtOpen =
      conversation?.type === 'internal' || conversation?.type === 'session'
        ? 0
        : (conversation?.sidebar.unreadCount ?? 0)
    set({
      threads: {
        ...get().threads,
        [conversationId]: {
          items: existing?.items ?? [],
          hasMore: existing?.hasMore ?? false,
          loading: true,
          unreadAtOpen,
          loaded: existing?.loaded ?? false,
          error: false,
        },
      },
    })
    try {
      const page = await api().call('listMessages', {
        params: { workspaceId, conversationId },
        query: { limit: Math.max(PAGE_SIZE, unreadAtOpen + 10) },
      })
      const thread = get().threads[conversationId]
      set({
        threads: {
          ...get().threads,
          [conversationId]: {
            items: mergeMessages(thread?.items ?? [], page.messages),
            hasMore: existing?.loaded ? (thread?.hasMore ?? page.hasMore) : page.hasMore,
            loading: false,
            unreadAtOpen,
            loaded: true,
            error: false,
          },
        },
      })
      const retry = loadRetries.get(conversationId)
      if (retry) clearTimeout(retry.timer)
      loadRetries.delete(conversationId)
    } catch (err) {
      const thread = get().threads[conversationId]
      if (thread)
        set({ threads: { ...get().threads, [conversationId]: { ...thread, loading: false, error: true } } })
      scheduleReload(conversationId)
      throw err
    }
    void api()
      .call('markConversationRead', { params: { workspaceId, conversationId }, body: {} })
      .catch(() => undefined)
  }

  const isOpen = (conversationId: string) => {
    const { selectedConversationId, internalConversationId, screen } = get()
    return (
      selectedConversationId === conversationId ||
      internalConversationId === conversationId ||
      (screen.kind === 'session' && screen.conversationId === conversationId)
    )
  }

  /** A failed load of the open conversation is retried with backoff instead of leaving an empty chat. */
  const scheduleReload = (conversationId: string) => {
    const previous = loadRetries.get(conversationId)
    if (previous) clearTimeout(previous.timer)
    const attempt = (previous?.attempt ?? -1) + 1
    const delay = LOAD_RETRY_MS[Math.min(attempt, LOAD_RETRY_MS.length - 1)] as number
    const timer = setTimeout(() => {
      if (isOpen(conversationId) && get().threads[conversationId]?.error)
        void loadLatest(conversationId).catch(() => undefined)
      else loadRetries.delete(conversationId)
    }, delay)
    loadRetries.set(conversationId, { attempt, timer })
  }

  const loadOlder = async (conversationId: string) => {
    const workspaceId = get().workspaceId
    const thread = get().threads[conversationId]
    if (!workspaceId || !thread || thread.loading || !thread.hasMore) return
    set({ threads: { ...get().threads, [conversationId]: { ...thread, loading: true } } })
    try {
      const page = await api().call('listMessages', {
        params: { workspaceId, conversationId },
        query: { limit: PAGE_SIZE, before: thread.items[0]?.id },
      })
      const latest = get().threads[conversationId] ?? thread
      set({
        threads: {
          ...get().threads,
          [conversationId]: {
            ...latest,
            items: mergeMessages(latest.items, page.messages),
            hasMore: page.hasMore,
            loading: false,
          },
        },
      })
    } catch {
      const latest = get().threads[conversationId] ?? thread
      set({ threads: { ...get().threads, [conversationId]: { ...latest, loading: false } } })
    }
  }

  const send = async (conversationId: string, content: string, attachmentIds?: string[]) => {
    const conversation = get().conversations[conversationId]
    const targets = conversation ? replyTargets(conversation, content, get().bots) : []
    const at = Date.now()
    const pending = markPendingReplies(get(), conversationId, targets, at)
    if (pending) {
      set(pending)
      expirePendingReplies(targets, at)
    }
    let message: Message
    try {
      message = await api().call('postMessage', {
        params: { workspaceId: ws(), conversationId },
        body: { content, ...(attachmentIds?.length ? { attachmentIds } : {}) },
      })
    } catch (err) {
      const cleared = pending ? clearPendingReplies(get(), targets, at) : null
      if (cleared) set(cleared)
      throw err
    }
    const threads = appendToThread(get().threads, message)
    if (threads) set({ threads })
    const thread = get().threads[conversationId]
    if (thread && thread.unreadAtOpen > 0) {
      set({ threads: { ...get().threads, [conversationId]: { ...thread, unreadAtOpen: 0 } } })
    }
  }

  return { replaceMessage, afterMessageCreated, loadLatest, loadOlder, send }
}
