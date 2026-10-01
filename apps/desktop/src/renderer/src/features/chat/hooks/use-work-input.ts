import { useMemo } from 'react'

import type { WorkingInput } from '@/features/chat/lib/working'
import { useAppStore } from '@/features/workspace/store'

export type WorkInput = Pick<
  WorkingInput,
  'conversation' | 'bots' | 'pending' | 'botConversation' | 'statusSession' | 'lane'
>

/** What `workingCandidates`/`stoppableBots` read about a conversation; null while it is unknown. */
export function useWorkInput(conversationId: string, lane?: { status: string }): WorkInput | null {
  const conversation = useAppStore((s) => s.conversations[conversationId])
  const bots = useAppStore((s) => s.bots)
  const pending = useAppStore((s) => s.pendingReplies)
  const botConversation = useAppStore((s) => s.botConversation)
  const statusSession = useAppStore((s) => s.statusSession)
  return useMemo(
    () => (conversation ? { conversation, bots, pending, botConversation, statusSession, lane } : null),
    [conversation, bots, pending, botConversation, statusSession, lane],
  )
}
