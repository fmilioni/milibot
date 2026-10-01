import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { stoppableBots } from '@/features/chat/lib/working'
import { useAppStore } from '@/features/workspace/store'

import { useWorkInput } from './use-work-input'

/** "Stopping…" gives way to "Stop" again if the bots are still busy after this (lets the user retry). */
const STOP_RETRY_MS = 15_000
/** A session's conversation: "Stop" stops the session's lane, not the bot's chats. */
export interface ComposerSession {
  id: string
  lane: { status: string }
}
/** "Stop" in the composer: stops every bot working on this conversation (the VM panel's "Stop task"). */
export function useChatStop(conversationId: string, session: ComposerSession | undefined) {
  const { t, i18n } = useTranslation()
  const bots = useAppStore((s) => s.bots)
  const controlBot = useAppStore((s) => s.controlBot)
  const showToast = useAppStore((s) => s.showToast)
  const [requested, setRequested] = useState<string[]>([])

  const workInput = useWorkInput(conversationId, session?.lane)
  const botIds = useMemo(() => (workInput ? stoppableBots(workInput) : []), [workInput])
  const stopping = requested.some((id) => botIds.includes(id))
  const [shownConversation, setShownConversation] = useState(conversationId)
  if (shownConversation !== conversationId) {
    setShownConversation(conversationId)
    setRequested([])
  } else if (requested.length > 0 && !stopping) setRequested([])

  useEffect(() => {
    if (!stopping) return
    const timer = setTimeout(() => setRequested([]), STOP_RETRY_MS)
    return () => clearTimeout(timer)
  }, [stopping])

  const names = new Intl.ListFormat(i18n.language, { type: 'conjunction' }).format(
    botIds.flatMap((id) => bots[id]?.name ?? []),
  )

  const run = async () => {
    if (botIds.length === 0 || stopping) return
    const ids = botIds
    setRequested(ids)
    const options = session ? { sessionId: session.id } : { scope: 'chat' as const }
    const results = await Promise.allSettled(ids.map((id) => controlBot(id, 'stop', options)))
    if (results.some((r) => r.status === 'rejected')) {
      setRequested([])
      showToast('error')
    }
  }

  return {
    visible: botIds.length > 0,
    canStop: botIds.length > 0 && !stopping,
    stopping,
    label: t('chat.stopLabel', { names, count: botIds.length }),
    run,
  }
}
