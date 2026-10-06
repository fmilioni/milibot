import type {
  BotMcpServer,
  CreateMcpServerBody,
  McpServer,
  McpTestResult,
  UpdateBotMcpServerBody,
  UpdateMcpServerBody,
  WorkspaceEvent,
} from '@milibot/shared'
import { create } from 'zustand'

import { api } from '@/api/daemon'
import { createWorkspaceScope } from '@/api/workspace-scope'
import { removeById, upsertById } from '@/lib/collections'

/** Stable empty list for selectors (a fresh `[]` re-renders on every store read). */
export const NO_MCP_SERVERS: McpServer[] = []

interface McpState {
  /** Workspace the lists below belong to (null: not loaded yet). */
  workspaceId: string | null
  servers: McpServer[]
  loading: boolean
  /** Per-bot switches, loaded when the bot's settings open. */
  botServers: Record<string, BotMcpServer[] | undefined>

  load(workspaceId: string): Promise<void>
  loadBot(workspaceId: string, botId: string): Promise<void>
  create(workspaceId: string, body: CreateMcpServerBody): Promise<McpServer>
  update(workspaceId: string, serverId: string, body: UpdateMcpServerBody): Promise<McpServer>
  remove(workspaceId: string, serverId: string): Promise<void>
  testDraft(workspaceId: string, body: CreateMcpServerBody, serverId?: string): Promise<McpTestResult>
  test(workspaceId: string, serverId: string): Promise<McpTestResult>
  /** Starts the OAuth sign-in and opens the browser (nothing opens when the sign-in could be refreshed). */
  connectOAuth(workspaceId: string, serverId: string): Promise<void>
  cancelOAuth(workspaceId: string, serverId: string): Promise<void>
  disconnectOAuth(workspaceId: string, serverId: string): Promise<void>
  updateBotServer(
    workspaceId: string,
    botId: string,
    serverId: string,
    body: UpdateBotMcpServerBody,
  ): Promise<void>
  applyEvent(workspaceId: string, event: WorkspaceEvent): void
}

export const useMcpStore = create<McpState>()((set, get) => {
  const { forWorkspace, isCurrent, commit } = createWorkspaceScope(get, set, () => ({
    servers: [],
    botServers: {},
  }))

  return {
    workspaceId: null,
    servers: [],
    loading: false,
    botServers: {},

    async load(workspaceId) {
      forWorkspace(workspaceId)
      set({ loading: true })
      try {
        const servers = await api().call('listMcpServers', { params: { workspaceId } })
        commit(workspaceId, { servers })
      } finally {
        set({ loading: false })
      }
    },

    async loadBot(workspaceId, botId) {
      forWorkspace(workspaceId)
      const [servers, prefs] = await Promise.all([
        api().call('listMcpServers', { params: { workspaceId } }),
        api().call('listBotMcpServers', { params: { workspaceId, botId } }),
      ])
      commit(workspaceId, () => ({ servers, botServers: { ...get().botServers, [botId]: prefs } }))
    },

    async create(workspaceId, body) {
      const server = await api().call('createMcpServer', { params: { workspaceId }, body })
      commit(workspaceId, { servers: upsertById(get().servers, server) })
      return server
    },

    async update(workspaceId, serverId, body) {
      const server = await api().call('updateMcpServer', { params: { workspaceId, serverId }, body })
      commit(workspaceId, { servers: upsertById(get().servers, server), botServers: {} })
      return server
    },

    async remove(workspaceId, serverId) {
      await api().call('deleteMcpServer', { params: { workspaceId, serverId } })
      commit(workspaceId, { servers: removeById(get().servers, serverId), botServers: {} })
    },

    testDraft: (workspaceId, config, serverId) =>
      api().call('testMcpDraft', {
        params: { workspaceId },
        body: { config, ...(serverId ? { serverId } : {}) },
      }),

    test: (workspaceId, serverId) => api().call('testMcpServer', { params: { workspaceId, serverId } }),

    async connectOAuth(workspaceId, serverId) {
      const { authorizationUrl, server } = await api().call('startMcpOAuth', {
        params: { workspaceId, serverId },
      })
      commit(workspaceId, { servers: upsertById(get().servers, server) })
      if (authorizationUrl) await window.milibot.openExternal(authorizationUrl)
    },

    async cancelOAuth(workspaceId, serverId) {
      const server = await api().call('cancelMcpOAuth', { params: { workspaceId, serverId } })
      commit(workspaceId, { servers: upsertById(get().servers, server) })
    },

    async disconnectOAuth(workspaceId, serverId) {
      const server = await api().call('disconnectMcpOAuth', { params: { workspaceId, serverId } })
      commit(workspaceId, { servers: upsertById(get().servers, server) })
    },

    async updateBotServer(workspaceId, botId, serverId, body) {
      const current = get().botServers[botId]
      // Optimistic: switches flip at once; a failure reloads the bot's list.
      if (current) {
        set({
          botServers: {
            ...get().botServers,
            [botId]: current.map((p) => (p.serverId === serverId ? { ...p, ...body } : p)),
          },
        })
      }
      try {
        const saved = await api().call('updateBotMcpServer', {
          params: { workspaceId, botId, serverId },
          body,
        })
        const latest = get().botServers[botId]
        if (latest)
          set({
            botServers: {
              ...get().botServers,
              [botId]: latest.map((p) => (p.serverId === serverId ? saved : p)),
            },
          })
      } catch (err) {
        await get()
          .loadBot(workspaceId, botId)
          .catch(() => undefined)
        throw err
      }
    },

    applyEvent(workspaceId, event) {
      if (!isCurrent(workspaceId)) return
      if (event.type === 'mcp.server.updated') {
        set({ servers: upsertById(get().servers, event.payload.server) })
      } else if (event.type === 'mcp.server.deleted') {
        set({ servers: removeById(get().servers, event.payload.serverId), botServers: {} })
      } else if (event.type === 'mcp.bot_server.updated') {
        const { botId, server } = event.payload
        const list = get().botServers[botId]
        if (!list) return
        const next = list.some((p) => p.serverId === server.serverId)
          ? list.map((p) => (p.serverId === server.serverId ? server : p))
          : [...list, server]
        set({ botServers: { ...get().botServers, [botId]: next } })
      }
    },
  }
})
