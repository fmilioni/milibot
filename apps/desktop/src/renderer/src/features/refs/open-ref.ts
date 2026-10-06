import type { RefInfo } from '@milibot/shared'

import { useSkillsStore } from '@/features/skills/store'
import { useAppStore } from '@/features/workspace/store'

/** Dialogs a link opens over the current screen. */
export interface RefDialogs {
  openPlan: (planId: string) => void
  openDoc: (docId: string) => void
}

async function openDirectChat(botId: string): Promise<boolean> {
  const store = useAppStore.getState()
  const dm = Object.values(store.conversations).find(
    (c) => c.type === 'direct' && c.memberBotIds.includes(botId),
  )
  if (!dm) return false
  await store.openConversation(dm.id)
  return true
}

/** Opens the item an id in text stands for, on its own screen or in a dialog. */
export async function openRef(info: RefInfo, dialogs: RefDialogs): Promise<void> {
  const store = useAppStore.getState()
  switch (info.kind) {
    case 'card':
      store.navigate({ kind: 'boards', boardId: info.boardId ?? null, cardId: info.id })
      return
    case 'board':
      store.openBoards(info.id)
      return
    case 'design':
      return store.openCanvas(info.id, null)
    case 'frame':
      if (info.designId) await store.openCanvas(info.designId, null)
      return
    case 'plan':
      dialogs.openPlan(info.id)
      return
    case 'session':
      return store.openWorkSession(info.id)
    case 'doc':
      dialogs.openDoc(info.id)
      return
    case 'project':
      store.openSettings('projects')
      return
    case 'skill':
      useSkillsStore.getState().openSkill(info.id)
      return
    case 'routine':
      if (info.botId && (await openDirectChat(info.botId))) store.openRightPanel('bot', 'routines')
      return
    case 'bot':
      await openDirectChat(info.id)
      return
    case 'conversation':
      if (info.conversationType === 'session' && info.sessionId) return store.openWorkSession(info.sessionId)
      if (info.conversationType === 'internal') return store.openInternalConversation(info.id)
      return store.openConversation(info.id)
  }
}
