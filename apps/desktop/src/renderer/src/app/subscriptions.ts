import type { WorkspaceEvent } from '@milibot/shared'

import { followCacheUpdates } from '@/api/cache-updates'
import { subscribeAppEvents, subscribeWorkspaceEvents } from '@/api/daemon'
import { queryClient } from '@/api/query-client'
import { useBoardStore } from '@/features/boards/store'
import { useDesignStore } from '@/features/canvas/store'
import { applyAttachmentEvent } from '@/features/chat/attachment-store'
import { useFilesStore } from '@/features/files/store'
import { applyOfficeEvent } from '@/features/knowledge/office-store'
import { useKnowledgeStore } from '@/features/knowledge/store'
import { useMcpStore } from '@/features/mcp/store'
import { usePlanStore } from '@/features/plans/store'
import { useProjectStore } from '@/features/projects/store'
import { useSessionStore } from '@/features/sessions/store'
import { useSettingsStore } from '@/features/settings/store'
import { applySetupAppEvent } from '@/features/setup/store'
import { followSkillsScreen, useSkillsStore } from '@/features/skills/store'
import { applyTeachEvent, followTeachWorkspace } from '@/features/vm/teach-store'
import { installDevHook } from '@/features/workspace/store/dev-hook'
import { registerAppEffects } from '@/features/workspace/store/effects'

type WorkspaceEventHandler = (workspaceId: string, event: WorkspaceEvent) => void

interface EventStore {
  getState(): { applyEvent: WorkspaceEventHandler }
}

/** Stores that keep workspace data current from the event stream (after the app store has applied it). */
const EVENT_STORES: EventStore[] = [
  useBoardStore,
  useDesignStore,
  useFilesStore,
  useKnowledgeStore,
  useMcpStore,
  usePlanStore,
  useProjectStore,
  useSessionStore,
  useSettingsStore,
  useSkillsStore,
]

const EVENT_HANDLERS: WorkspaceEventHandler[] = [applyAttachmentEvent, applyOfficeEvent, applyTeachEvent]

let registered = false

/**
 * Wires the stores to the event streams and to each other, once per window, before the first render.
 * Importing a store has no side effects: everything that listens is registered here.
 */
export function registerSubscriptions(): void {
  if (registered) return
  registered = true
  for (const store of EVENT_STORES)
    subscribeWorkspaceEvents((workspaceId, event) => store.getState().applyEvent(workspaceId, event))
  for (const handler of EVENT_HANDLERS) subscribeWorkspaceEvents(handler)
  subscribeAppEvents(applySetupAppEvent)
  followCacheUpdates(queryClient)
  followSkillsScreen()
  followTeachWorkspace()
  registerAppEffects()
  if (import.meta.env.DEV) installDevHook()
}
