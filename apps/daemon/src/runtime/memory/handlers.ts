import { MEMORY_SETTING_KEYS, type memoryEndpoints } from '@milibot/shared'

import type { EndpointHandlers } from '../../handlers'
import type { WorkspaceStore } from '../workspace-store'
import type { MemoryStore } from './store'

/** Memory notes (the bots' and the workspace's), the conversation summaries and the memory settings. */
export class MemoryRoutes {
  constructor(private readonly deps: { store: WorkspaceStore; memory: MemoryStore }) {}

  handlers(): EndpointHandlers<keyof typeof memoryEndpoints> {
    const { store, memory } = this.deps
    const settings = () => memory.settings((key, fallback) => store.settings.get(key, fallback))
    return {
      listBotMemories: ({ params }) => {
        store.bots.get(params.botId)
        return memory.listNotes(params.botId)
      },
      createBotMemory: ({ params, body }) => {
        store.bots.get(params.botId)
        return memory.saveNote({ botId: params.botId, content: body.content, pinned: body.pinned })
      },
      updateBotMemory: ({ params, body }) => memory.updateNote(params.botId, params.memoryId, body),
      deleteBotMemory: ({ params }) => {
        memory.deleteNote(params.botId, params.memoryId)
        return { ok: true as const }
      },
      listConversationSummaries: ({ params, query }) => {
        store.conversations.get(params.conversationId)
        return memory.listSummaries(params.conversationId, {
          ...(query.botId ? { botId: query.botId } : {}),
          active: query.active,
        })
      },
      listWorkspaceMemories: () => memory.listWorkspaceNotes(),
      createWorkspaceMemory: ({ body }) =>
        memory.saveNote({
          botId: '',
          content: body.content,
          pinned: true,
          scope: 'workspace',
          projectId: body.projectId ?? null,
        }),
      updateWorkspaceMemory: ({ params, body }) => memory.updateNote('workspace', params.memoryId, body),
      deleteWorkspaceMemory: ({ params }) => {
        memory.deleteNote('workspace', params.memoryId)
        return { ok: true as const }
      },
      getMemorySettings: () => settings(),
      updateMemorySettings: ({ body }) => {
        store.settings.setMany(MEMORY_SETTING_KEYS, body)
        return settings()
      },
    }
  }
}
