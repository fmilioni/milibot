import {
  ApiError,
  type SessionChanges,
  type SessionFileDiff,
  type SessionFileImages,
  type WorkSession,
  type WorkSessionDetail,
  type WorkspaceEvent,
} from '@milibot/shared'
import { create } from 'zustand'

import { api } from '@/api/daemon'
import { createWorkspaceScope } from '@/api/workspace-scope'
import { nextStatusDetail, type StatusDetail } from '@/features/bots/lib/bot-status'
import {
  isSessionFinished,
  OPEN_SESSION_STATUSES,
  type SessionFilters,
  sessionMatchesFilters,
} from '@/features/sessions/lib/session-view'
import { type Loadable, loadEntry } from '@/lib/loadable'

interface SessionState {
  /** Workspace the cached sessions belong to. */
  workspaceId: string | null
  /** Every session seen (list, detail, events), by id. */
  sessions: Record<string, WorkSession>
  details: Record<string, WorkSessionDetail>
  /** What each session's lane is doing, kept between tool calls like the bots' status. */
  laneDetail: Record<string, StatusDetail | undefined>
  changes: Record<string, Loadable<SessionChanges>>
  /** Per `sessionId\npath`; dropped when the session's files change. */
  fileDiffs: Record<string, Loadable<SessionFileDiff>>
  /** Changed images before and after, keyed and dropped like `fileDiffs`. */
  fileImages: Record<string, Loadable<SessionFileImages>>
  /** Ids of the filtered list (settings › Sessions). */
  list: string[]
  listLoading: boolean
  filters: SessionFilters
  /** Session on screen: its changes and steps follow the events (others are refetched when opened). */
  watching: string | null

  watch(sessionId: string | null): void

  loadList(workspaceId: string, filters?: SessionFilters): Promise<void>
  /** Every session still going on (preparing, running or waiting), for the sidebar's "in progress". */
  loadOpen(workspaceId: string): Promise<void>
  /** Fetches a session not seen yet (a plan card's); once per session, failures included. */
  ensure(workspaceId: string, sessionId: string): void
  loadDetail(workspaceId: string, sessionId: string): Promise<WorkSessionDetail>
  loadChanges(workspaceId: string, sessionId: string): Promise<void>
  loadFileDiff(workspaceId: string, sessionId: string, path: string): Promise<void>
  loadFileImages(workspaceId: string, sessionId: string, path: string): Promise<void>
  stop(workspaceId: string, sessionId: string): Promise<void>
  remove(workspaceId: string, sessionId: string): Promise<void>
  /** The session a conversation of type `session` belongs to (looked up among the bot's sessions). */
  findByConversation(workspaceId: string, conversationId: string, botId: string): Promise<WorkSession | null>
  applyEvent(workspaceId: string, event: WorkspaceEvent): void
}

export const diffKey = (sessionId: string, path: string) => `${sessionId}\n${path}`

const newestFirst = (sessions: WorkSession[]) => [...sessions].sort((a, b) => b.createdAt - a.createdAt)

/** `workspaceId\nsessionId` of the sessions `ensure` already asked for. */
const ensured = new Set<string>()

export const useSessionStore = create<SessionState>()((set, get) => {
  const { forWorkspace, isCurrent, commit } = createWorkspaceScope(get, set, () => {
    ensured.clear()
    return { sessions: {}, details: {}, laneDetail: {}, changes: {}, fileDiffs: {}, fileImages: {}, list: [] }
  })

  const upsert = (session: WorkSession) => {
    const previous = get().sessions[session.id]
    const detail = get().details[session.id]
    const laneChanged =
      !previous ||
      previous.lane.status !== session.lane.status ||
      previous.lane.detail !== session.lane.detail
    set({
      sessions: { ...get().sessions, [session.id]: session },
      ...(detail ? { details: { ...get().details, [session.id]: { ...detail, ...session } } } : {}),
      ...(laneChanged
        ? {
            laneDetail: {
              ...get().laneDetail,
              [session.id]: nextStatusDetail(get().laneDetail[session.id], {
                status: session.lane.status,
                detail: session.lane.detail ?? undefined,
              }),
            },
          }
        : {}),
    })
    const listed = get().list.includes(session.id)
    const matches = sessionMatchesFilters(session, get().filters)
    if (listed !== matches) {
      const ids = matches ? [...get().list, session.id] : get().list.filter((id) => id !== session.id)
      set({ list: newestFirst(ids.flatMap((id) => get().sessions[id] ?? [])).map((s) => s.id) })
    }
  }

  const isShowing = (workspaceId: string) => () => isCurrent(workspaceId)

  return {
    workspaceId: null,
    sessions: {},
    details: {},
    laneDetail: {},
    changes: {},
    fileDiffs: {},
    fileImages: {},
    list: [],
    listLoading: false,
    filters: {},
    watching: null,

    watch(sessionId) {
      set({ watching: sessionId })
    },

    async loadList(workspaceId, filters = get().filters) {
      forWorkspace(workspaceId)
      set({ listLoading: true, filters })
      try {
        const query = Object.fromEntries(Object.entries(filters).filter(([, v]) => v)) as SessionFilters
        const sessions = await api().call('listWorkSessions', { params: { workspaceId }, query })
        if (!isCurrent(workspaceId) || get().filters !== filters) return
        for (const session of sessions) upsert(session)
        set({ list: newestFirst(sessions).map((s) => s.id) })
      } finally {
        set({ listLoading: false })
      }
    },

    async loadOpen(workspaceId) {
      forWorkspace(workspaceId)
      const lists = await Promise.all(
        OPEN_SESSION_STATUSES.map((status) =>
          api().call('listWorkSessions', { params: { workspaceId }, query: { status } }),
        ),
      )
      if (!isCurrent(workspaceId)) return
      const open = lists.flat()
      for (const session of open) upsert(session)
      // Open ones missing from the lists ended while the event stream was down.
      const openIds = new Set(open.map((s) => s.id))
      const stale = Object.values(get().sessions).filter(
        (s) => !isSessionFinished(s.status) && !openIds.has(s.id),
      )
      for (const session of stale)
        void api()
          .call('getWorkSession', { params: { workspaceId, sessionId: session.id } })
          .then((fresh) => {
            if (isCurrent(workspaceId)) upsert(fresh)
          })
          .catch((err: unknown) => {
            if (err instanceof ApiError && err.code === 'not_found' && isCurrent(workspaceId))
              get().applyEvent(workspaceId, {
                type: 'work_session.deleted',
                payload: { sessionId: session.id },
              })
          })
    },

    ensure(workspaceId, sessionId) {
      const key = `${workspaceId}\n${sessionId}`
      if (isCurrent(workspaceId) && get().sessions[sessionId]) return
      if (ensured.has(key)) return
      ensured.add(key)
      forWorkspace(workspaceId)
      void api()
        .call('getWorkSession', { params: { workspaceId, sessionId } })
        .then((session) => {
          if (isCurrent(workspaceId)) upsert(session)
        })
        .catch(() => undefined)
    },

    async loadDetail(workspaceId, sessionId) {
      forWorkspace(workspaceId)
      const detail = await api().call('getWorkSession', { params: { workspaceId, sessionId } })
      if (commit(workspaceId, () => ({ details: { ...get().details, [sessionId]: detail } }))) upsert(detail)
      return detail
    },

    async loadChanges(workspaceId, sessionId) {
      forWorkspace(workspaceId)
      await loadEntry(
        () => get().changes,
        (changes) => set({ changes }),
        sessionId,
        () => api().call('getWorkSessionChanges', { params: { workspaceId, sessionId } }),
        isShowing(workspaceId),
      )
    },

    async loadFileDiff(workspaceId, sessionId, path) {
      forWorkspace(workspaceId)
      await loadEntry(
        () => get().fileDiffs,
        (fileDiffs) => set({ fileDiffs }),
        diffKey(sessionId, path),
        () => api().call('getWorkSessionFileDiff', { params: { workspaceId, sessionId }, query: { path } }),
        isShowing(workspaceId),
      )
    },

    async loadFileImages(workspaceId, sessionId, path) {
      forWorkspace(workspaceId)
      await loadEntry(
        () => get().fileImages,
        (fileImages) => set({ fileImages }),
        diffKey(sessionId, path),
        () => api().call('getWorkSessionFileImages', { params: { workspaceId, sessionId }, query: { path } }),
        isShowing(workspaceId),
      )
    },

    async stop(workspaceId, sessionId) {
      upsert(await api().call('stopWorkSession', { params: { workspaceId, sessionId } }))
    },

    async remove(workspaceId, sessionId) {
      await api().call('deleteWorkSession', { params: { workspaceId, sessionId } })
    },

    async findByConversation(workspaceId, conversationId, botId) {
      forWorkspace(workspaceId)
      const known = Object.values(get().sessions).find((s) => s.conversationId === conversationId)
      if (known) return known
      const sessions = await api().call('listWorkSessions', { params: { workspaceId }, query: { botId } })
      for (const session of sessions) upsert(session)
      return sessions.find((s) => s.conversationId === conversationId) ?? null
    },

    applyEvent(workspaceId, event) {
      if (event.type === 'work_session.updated') forWorkspace(workspaceId)
      if (!isCurrent(workspaceId)) return
      switch (event.type) {
        case 'work_session.updated': {
          const { session } = event.payload
          const previous = get().sessions[session.id]
          upsert(session)
          const stepsChanged =
            previous?.steps.done !== session.steps.done || previous.steps.total !== session.steps.total
          if (get().watching === session.id && stepsChanged)
            void get()
              .loadDetail(workspaceId, session.id)
              .catch(() => undefined)
          break
        }
        case 'work_session.deleted': {
          const { sessionId } = event.payload
          const sessions = { ...get().sessions }
          const details = { ...get().details }
          delete sessions[sessionId]
          delete details[sessionId]
          set({ sessions, details, list: get().list.filter((id) => id !== sessionId) })
          break
        }
        case 'work_session.files_changed': {
          const { sessionId, totals } = event.payload
          const session = get().sessions[sessionId]
          if (session) upsert({ ...session, changes: totals })
          const prefix = `${sessionId}\n`
          const others = <T>(entries: Record<string, T>) =>
            Object.fromEntries(Object.entries(entries).filter(([key]) => !key.startsWith(prefix)))
          set({ fileDiffs: others(get().fileDiffs), fileImages: others(get().fileImages) })
          if (get().watching === sessionId) void get().loadChanges(workspaceId, sessionId)
          else {
            const changes = { ...get().changes }
            delete changes[sessionId]
            set({ changes })
          }
          break
        }
        case 'plan.updated': {
          const plan = event.payload.plan
          const session = Object.values(get().details).find((d) => d.planId === plan.id)
          if (session && session.id === get().watching)
            void get()
              .loadDetail(workspaceId, session.id)
              .catch(() => undefined)
          break
        }
      }
    },
  }
})
