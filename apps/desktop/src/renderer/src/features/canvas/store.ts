import type {
  Design,
  DesignDetail,
  DesignFrame,
  DesignProblem,
  DesignRevision,
  DesignToken,
  WorkspaceEvent,
} from '@milibot/shared'
import { create } from 'zustand'

import { api } from '@/api/daemon'
import { createWorkspaceScope } from '@/api/workspace-scope'
import {
  applyDraftEvent,
  type DraftsByDesign,
  nextDraftExpiry,
  pruneDrafts,
} from '@/features/canvas/lib/design-drafts'
import { applyTokenEdit, tokenEdit } from '@/features/canvas/lib/design-tokens'
import { screenIs, useAppStore } from '@/features/workspace/store'
import { type Loadable, loadEntry } from '@/lib/loadable'

/** A frame's compiled page in one theme. */
export interface FrameDoc {
  /** `updatedAt` of the frame + key of the theme's values it was compiled for. */
  version: string
  html: string | null
  problems: DesignProblem[]
  loading: boolean
  error: boolean
}

export interface Presence {
  botId: string
  frameId: string | null
  active: boolean
  mode: 'write' | 'read'
  /** Last event (epoch ms). */
  at: number
  /** When this frame and mode became active. */
  since: number
}

/** Presence of each bot, per design. */
export type PresenceByBot = Record<string, Presence | undefined>

/** The user's last token edit, for "Undo" (canvas.variables.undo) in the variables panel. */
interface TokenUndo {
  designId: string
  revisionId: string
  token: string
  theme: string | null
}

/** "Ask for a change" on a frame: the frame the next message in a conversation is about. */
interface FrameAsk {
  designId: string
  frameId: string
  frameName: string
  designName: string
  /** Changes every time it is asked again, to focus the composer. */
  at: number
}

interface DesignState {
  workspaceId: string | null
  designs: Record<string, Design>
  details: Record<string, DesignDetail>
  /** Designs of a conversation, newest first. */
  byConversation: Record<string, string[] | undefined>
  /** Every design of the workspace is in `designs` (the designs screen loaded them). */
  allLoaded: boolean
  /** Keyed by `frameId\ntheme`. */
  docs: Record<string, FrameDoc>
  /** Content height of `auto` frames measured in the app. */
  measured: Record<string, number>
  presence: Record<string, PresenceByBot | undefined>
  /** Frames bots are still writing, per design. */
  drafts: DraftsByDesign
  revisions: Record<string, Loadable<DesignRevision[]>>
  undo: TokenUndo | null
  asks: Record<string, FrameAsk | undefined>

  askAboutFrame(conversationId: string, ask: Omit<FrameAsk, 'at'>): void
  clearAsk(conversationId: string): void
  /** Designs of a conversation (and, with `botId`, every design of that bot), newest first. */
  loadForConversation(workspaceId: string, conversationId: string, botId?: string): Promise<void>
  /** Every design of the workspace, archived included. */
  loadAll(workspaceId: string): Promise<void>
  load(workspaceId: string, designId: string): Promise<DesignDetail>
  /** Fetches a frame's page when the cached one is missing or older than `version`. */
  ensureDoc(workspaceId: string, designId: string, frameId: string, theme: string, version: string): void
  setMeasured(frameId: string, height: number): void
  /** The user dropped a frame: moved here at once, then where the daemon placed it. */
  moveFrame(
    workspaceId: string,
    designId: string,
    frameId: string,
    x: number,
    y: number,
  ): Promise<DesignFrame>
  editToken(
    workspaceId: string,
    designId: string,
    token: DesignToken,
    theme: string,
    value: string | number,
  ): Promise<void>
  undoTokenEdit(workspaceId: string): Promise<void>
  loadRevisions(workspaceId: string, designId: string): Promise<void>
  restoreRevision(workspaceId: string, designId: string, revisionId: string): Promise<void>
  archiveDesign(workspaceId: string, designId: string, archived: boolean): Promise<void>
  renameDesign(workspaceId: string, designId: string, name: string): Promise<void>
  deleteDesign(workspaceId: string, designId: string): Promise<void>
  applyEvent(workspaceId: string, event: WorkspaceEvent): void
}

export const docKey = (frameId: string, theme: string) => `${frameId}\n${theme}`

const MAX_DOCS = 80
const MAX_PARALLEL_DOCS = 3

const byPosition = (frames: DesignFrame[]) => [...frames].sort((a, b) => a.position - b.position)

export const useDesignStore = create<DesignState>()((set, get) => {
  const { forWorkspace, isCurrent } = createWorkspaceScope(get, set, () => {
    queue.length = 0
    wanted.clear()
    return {
      designs: {},
      details: {},
      byConversation: {},
      allLoaded: false,
      docs: {},
      measured: {},
      presence: {},
      drafts: {},
      revisions: {},
      undo: null,
      asks: {},
    }
  })

  let expiry: ReturnType<typeof setTimeout> | null = null
  const setDrafts = (drafts: DraftsByDesign) => {
    if (drafts !== get().drafts) set({ drafts })
    if (expiry) clearTimeout(expiry)
    expiry = null
    const next = nextDraftExpiry(drafts)
    if (next !== null)
      expiry = setTimeout(() => setDrafts(pruneDrafts(get().drafts, Date.now())), next - Date.now() + 50)
  }

  const upsertDesign = (design: Design) => {
    const detail = get().details[design.id]
    set({
      designs: { ...get().designs, [design.id]: design },
      ...(detail ? { details: { ...get().details, [design.id]: { ...detail, ...design } } } : {}),
    })
    if (design.conversationId) {
      const list = get().byConversation[design.conversationId]
      if (list && !list.includes(design.id))
        set({ byConversation: { ...get().byConversation, [design.conversationId]: [design.id, ...list] } })
    }
  }

  const setDoc = (key: string, doc: FrameDoc) => {
    const docs = { ...get().docs, [key]: doc }
    const keys = Object.keys(docs)
    // Oldest entries go first (insertion order); the pages are large (fonts are embedded).
    for (const old of keys.slice(0, Math.max(0, keys.length - MAX_DOCS))) delete docs[old]
    set({ docs })
  }

  const queue: Array<() => Promise<void>> = []
  /** Newest version asked for per doc key (a page may be asked for again while it loads). */
  const wanted = new Map<string, string>()
  let running = 0
  const pump = () => {
    while (running < MAX_PARALLEL_DOCS && queue.length) {
      const job = queue.shift() as () => Promise<void>
      running++
      void job().finally(() => {
        running--
        pump()
      })
    }
  }

  const setFrame = (designId: string, frame: DesignFrame, deleted = false) => {
    const detail = get().details[designId]
    if (!detail) return
    const others = detail.frames.filter((f) => f.id !== frame.id)
    const frames = deleted ? others : byPosition([...others, frame])
    set({
      details: {
        ...get().details,
        [designId]: { ...detail, frames, frameCount: frames.length },
      },
    })
  }

  return {
    workspaceId: null,
    designs: {},
    details: {},
    byConversation: {},
    allLoaded: false,
    docs: {},
    measured: {},
    presence: {},
    drafts: {},
    revisions: {},
    undo: null,
    asks: {},

    askAboutFrame(conversationId, ask) {
      set({ asks: { ...get().asks, [conversationId]: { ...ask, at: Date.now() } } })
    },

    clearAsk(conversationId) {
      if (!get().asks[conversationId]) return
      const asks = { ...get().asks }
      delete asks[conversationId]
      set({ asks })
    },

    async loadForConversation(workspaceId, conversationId, botId) {
      forWorkspace(workspaceId)
      const [own, ofBot] = await Promise.all([
        api().call('listDesigns', { params: { workspaceId }, query: { conversationId, archived: true } }),
        botId
          ? api().call('listDesigns', { params: { workspaceId }, query: { botId, archived: true } })
          : Promise.resolve([]),
      ])
      const designs = [...own, ...ofBot.filter((d) => !own.some((o) => o.id === d.id))].sort(
        (a, b) => b.updatedAt - a.updatedAt,
      )
      for (const d of designs) upsertDesign(d)
      set({ byConversation: { ...get().byConversation, [conversationId]: designs.map((d) => d.id) } })
    },

    async loadAll(workspaceId) {
      forWorkspace(workspaceId)
      const designs = await api().call('listDesigns', { params: { workspaceId }, query: { archived: true } })
      if (!isCurrent(workspaceId)) return
      for (const d of designs) upsertDesign(d)
      set({ allLoaded: true })
    },

    async load(workspaceId, designId) {
      forWorkspace(workspaceId)
      const detail = await api().call('getDesign', { params: { workspaceId, designId } })
      set({
        designs: { ...get().designs, [detail.id]: detail },
        details: { ...get().details, [detail.id]: { ...detail, frames: byPosition(detail.frames) } },
      })
      return detail
    },

    ensureDoc(workspaceId, designId, frameId, theme, version) {
      const key = docKey(frameId, theme)
      wanted.set(key, version)
      const current = get().docs[key]
      if (current?.loading || (current && current.version === version)) return
      setDoc(key, {
        version: current?.version ?? '',
        html: current?.html ?? null,
        problems: current?.problems ?? [],
        loading: true,
        error: false,
      })
      queue.push(async () => {
        const target = wanted.get(key) as string
        let next: FrameDoc
        try {
          const doc = await api().call('getDesignFrameHtml', {
            params: { workspaceId, designId, frameId },
            query: { theme },
          })
          const previous = get().docs[key]
          // The same page keeps the same string, so the iframe doesn't reload.
          const html = previous?.html === doc.html ? previous.html : doc.html
          next = { version: target, html, problems: doc.problems, loading: false, error: false }
        } catch {
          const previous = get().docs[key]
          next = { version: target, html: previous?.html ?? null, problems: [], loading: false, error: true }
        }
        if (!isCurrent(workspaceId)) return
        setDoc(key, next)
        const latest = wanted.get(key)
        if (latest && latest !== target) get().ensureDoc(workspaceId, designId, frameId, theme, latest)
      })
      pump()
    },

    setMeasured(frameId, height) {
      if (get().measured[frameId] === height) return
      set({ measured: { ...get().measured, [frameId]: height } })
    },

    async moveFrame(workspaceId, designId, frameId, x, y) {
      const frame = get().details[designId]?.frames.find((f) => f.id === frameId)
      if (frame) setFrame(designId, { ...frame, x, y })
      try {
        const saved = await api().call('moveDesignFrame', {
          params: { workspaceId, designId, frameId },
          body: { x: Math.round(x), y: Math.round(y) },
        })
        setFrame(designId, saved)
        return saved
      } catch (err) {
        if (frame) setFrame(designId, frame)
        throw err
      }
    },

    async editToken(workspaceId, designId, token, theme, value) {
      const detail = get().details[designId]
      const before = detail?.tokens
      if (detail)
        upsertDesign({
          ...detail,
          tokens: detail.tokens.map((t) => (t.name === token.name ? applyTokenEdit(t, theme, value) : t)),
        })
      try {
        const design = await api().call('updateDesignTokens', {
          params: { workspaceId, designId },
          body: { values: tokenEdit(token, theme, value) },
        })
        upsertDesign(design)
        const revisions = await api().call('listDesignRevisions', { params: { workspaceId, designId } })
        set({
          revisions: { ...get().revisions, [designId]: { data: revisions, loading: false, error: false } },
        })
        const mine = revisions.find((r) => r.authorType === 'user' && r.frameId === null)
        if (mine)
          set({
            undo: {
              designId,
              revisionId: mine.id,
              token: token.name,
              theme: token.value !== null ? null : theme,
            },
          })
      } catch (err) {
        if (detail && before) upsertDesign({ ...detail, tokens: before })
        throw err
      }
    },

    async undoTokenEdit(workspaceId) {
      const undo = get().undo
      if (!undo) return
      set({ undo: null })
      const detail = await api().call('restoreDesignRevision', {
        params: { workspaceId, designId: undo.designId, revisionId: undo.revisionId },
        body: { undo: true },
      })
      upsertDesign(detail)
    },

    async loadRevisions(workspaceId, designId) {
      await loadEntry(
        () => get().revisions,
        (revisions) => set({ revisions }),
        designId,
        () => api().call('listDesignRevisions', { params: { workspaceId, designId } }),
      )
    },

    async restoreRevision(workspaceId, designId, revisionId) {
      const detail = await api().call('restoreDesignRevision', {
        params: { workspaceId, designId, revisionId },
        body: {},
      })
      set({
        details: { ...get().details, [designId]: { ...detail, frames: byPosition(detail.frames) } },
        designs: { ...get().designs, [designId]: detail },
      })
      await get().loadRevisions(workspaceId, designId)
    },

    async archiveDesign(workspaceId, designId, archived) {
      const design = await api().call('archiveDesign', {
        params: { workspaceId, designId },
        body: { archived },
      })
      if (isCurrent(workspaceId)) upsertDesign(design)
    },

    async renameDesign(workspaceId, designId, name) {
      const design = await api().call('renameDesign', { params: { workspaceId, designId }, body: { name } })
      if (isCurrent(workspaceId)) upsertDesign(design)
    },

    async deleteDesign(workspaceId, designId) {
      await api().call('deleteDesign', { params: { workspaceId, designId } })
      get().applyEvent(workspaceId, { type: 'design.deleted', payload: { designId } })
    },

    applyEvent(workspaceId, event) {
      if (!isCurrent(workspaceId)) return
      const drafts = applyDraftEvent(get().drafts, event, Date.now())
      if (drafts !== get().drafts) setDrafts(drafts)
      switch (event.type) {
        case 'design.updated':
          upsertDesign(event.payload.design)
          if (get().revisions[event.payload.design.id])
            void get()
              .loadRevisions(workspaceId, event.payload.design.id)
              .catch(() => undefined)
          break
        case 'design.frame.updated':
          setFrame(event.payload.designId, event.payload.frame, event.payload.deleted)
          break
        case 'design.deleted': {
          const { designId } = event.payload
          const designs = { ...get().designs }
          const details = { ...get().details }
          delete designs[designId]
          delete details[designId]
          const byConversation = Object.fromEntries(
            Object.entries(get().byConversation).map(([k, ids]) => [k, ids?.filter((id) => id !== designId)]),
          )
          set({ designs, details, byConversation })
          if (screenIs(useAppStore.getState().screen, 'canvas')?.designId === designId)
            useAppStore.getState().closeCanvas()
          break
        }
        case 'design.presence': {
          const { designId, botId, frameId, active, mode } = event.payload
          const now = Date.now()
          const byBot = get().presence[designId]
          const previous = byBot?.[botId]
          const same = previous && previous.frameId === frameId && previous.mode === mode
          const since = active || !same ? now : previous.since
          set({
            presence: {
              ...get().presence,
              [designId]: { ...byBot, [botId]: { botId, frameId, active, mode, at: now, since } },
            },
          })
          break
        }
      }
    },
  }
})

function pickDesignFor(conversationId: string, botId: string | null, name: string | null): string | null {
  const { designs, byConversation, presence } = useDesignStore.getState()
  const own = (byConversation[conversationId] ?? []).flatMap((id) => designs[id] ?? [])
  if (name) {
    const named = own.find((d) => d.name === name) ?? Object.values(designs).find((d) => d.name === name)
    if (named) return named.id
  }
  if (botId) {
    const latest = Object.entries(presence)
      .flatMap(([designId, byBot]) => (byBot?.[botId] ? [{ designId, at: byBot[botId].at }] : []))
      .sort((a, b) => b.at - a.at)[0]
    if (latest) return latest.designId
  }
  return own[0]?.id ?? null
}

/**
 * Opens the design an activity step or a working bot refers to: by name (steps show the design's name), else
 * the one the bot last touched, else the conversation's newest.
 */
export async function openDesignFor(conversationId: string, botId: string | null, name: string | null) {
  let designId = pickDesignFor(conversationId, botId, name)
  const workspaceId = useAppStore.getState().workspaceId
  if (!designId && workspaceId) {
    await useDesignStore
      .getState()
      .loadForConversation(workspaceId, conversationId, botId ?? undefined)
      .catch(() => undefined)
    designId = pickDesignFor(conversationId, botId, name)
  }
  if (designId) await useAppStore.getState().openCanvas(designId, conversationId)
  else useAppStore.getState().showToast('error')
}
