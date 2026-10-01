import { toBase64 } from '@milibot/agent/llm'
import type { debugEndpoints } from '@milibot/shared'

import type { EndpointHandlers } from '../../handlers'
import type { FileBlobStore } from '../blobs'
import type { WorkspaceStore } from '../workspace-store'
import type { DebugStore } from './debug'
import type { LlmCallStore } from './llm-calls'
import type { DebugRetention } from './retention'
import type { ToolCallStore } from './tool-calls'

/** The debug screens: LLM and tool call logs, stored images, and the debug history's storage and purge. */
export class ObservabilityRoutes {
  constructor(
    private readonly deps: {
      store: WorkspaceStore
      llmCalls: LlmCallStore
      toolCalls: ToolCallStore
      debug: DebugStore
      retention: DebugRetention
      blobs: FileBlobStore
    },
  ) {}

  handlers(): EndpointHandlers<keyof typeof debugEndpoints> {
    const { store, llmCalls, toolCalls, debug, retention, blobs } = this.deps
    return {
      listLlmCalls: ({ params, query }) => llmCalls.list(params.conversationId, query),
      listToolCalls: ({ params, query }) => toolCalls.list(params.conversationId, query),
      getToolCallDiff: ({ params }) => toolCalls.getDiff(params.toolCallId),
      getLlmCall: ({ params }) => llmCalls.get(params.callId),
      getConversationDebug: ({ params }) => {
        store.conversations.get(params.conversationId)
        return debug.conversation(params.conversationId)
      },
      getBlob: async ({ params }) => {
        const blob = await blobs.get(params.sha)
        return { sha256: params.sha, mediaType: blob.mediaType, data: toBase64(blob.bytes) }
      },
      getDebugStorage: () => retention.storage(),
      purgeDebugData: async () => {
        const result = await retention.purge()
        return { ...result, storage: await retention.storage() }
      },
    }
  }
}
