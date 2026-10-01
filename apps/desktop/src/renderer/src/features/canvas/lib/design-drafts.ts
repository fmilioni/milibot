import type { DesignFrame, WorkspaceEvent } from '@milibot/shared'

export type FrameDraftEvent = Extract<WorkspaceEvent, { type: 'design.frame.draft' }>['payload']

/** A frame a bot is still writing, as the canvas shows it. */
export interface FrameDraft extends FrameDraftEvent {
  /** When the last update arrived (epoch ms). */
  at: number
}

/** Drafts per design, by `draftId`. */
export type DraftsByDesign = Record<string, Record<string, FrameDraft> | undefined>

/** A draft that stopped growing this long ago is dropped (the daemon missed clearing it). */
export const DRAFT_TTL_MS = 60_000

function withDesign(
  drafts: DraftsByDesign,
  designId: string,
  next: Record<string, FrameDraft>,
): DraftsByDesign {
  const out = { ...drafts }
  if (Object.keys(next).length) out[designId] = next
  else delete out[designId]
  return out
}

/** Applies a draft event, or drops the drafts a written frame makes obsolete; the same object when nothing changes. */
export function applyDraftEvent(drafts: DraftsByDesign, event: WorkspaceEvent, now: number): DraftsByDesign {
  switch (event.type) {
    case 'design.frame.draft': {
      const draft = event.payload
      return withDesign(drafts, draft.designId, {
        ...drafts[draft.designId],
        [draft.draftId]: { ...draft, at: now },
      })
    }
    case 'design.frame.draft.cleared': {
      const current = drafts[event.payload.designId]
      if (!current?.[event.payload.draftId]) return drafts
      const next = { ...current }
      delete next[event.payload.draftId]
      return withDesign(drafts, event.payload.designId, next)
    }
    case 'design.frame.updated':
      return dropWritten(drafts, event.payload.designId, event.payload.frame)
    case 'design.deleted': {
      if (!drafts[event.payload.designId]) return drafts
      return withDesign(drafts, event.payload.designId, {})
    }
    default:
      return drafts
  }
}

/** The frame a draft was for was written: it replaced that frame, or a new one landed with its name. */
function dropWritten(drafts: DraftsByDesign, designId: string, frame: DesignFrame): DraftsByDesign {
  const current = drafts[designId]
  if (!current) return drafts
  const name = frame.name.trim().toLowerCase()
  const keep = Object.values(current).filter((d) =>
    d.frameId ? d.frameId !== frame.id : d.name.trim().toLowerCase() !== name,
  )
  if (keep.length === Object.keys(current).length) return drafts
  return withDesign(drafts, designId, Object.fromEntries(keep.map((d) => [d.draftId, d])))
}

/** Drops drafts without updates for `DRAFT_TTL_MS`; the same object when none expired. */
export function pruneDrafts(drafts: DraftsByDesign, now: number): DraftsByDesign {
  let out = drafts
  for (const [designId, list] of Object.entries(drafts)) {
    if (!list) continue
    const keep = Object.values(list).filter((d) => now - d.at < DRAFT_TTL_MS)
    if (keep.length !== Object.keys(list).length)
      out = withDesign(out, designId, Object.fromEntries(keep.map((d) => [d.draftId, d])))
  }
  return out
}

/** The next time a draft expires, or null without drafts. */
export function nextDraftExpiry(drafts: DraftsByDesign): number | null {
  const times = Object.values(drafts).flatMap((list) => Object.values(list ?? {}).map((d) => d.at))
  return times.length ? Math.min(...times) + DRAFT_TTL_MS : null
}

interface PageLayer {
  id: number
  html: string
}

/**
 * The iframes of a draft: the version on screen, the one loading above it (hidden) and the newest version
 * waiting for that load. One load at a time, so a page slower to load than the updates still grows.
 */
export interface PageLayers {
  shown: PageLayer | null
  loading: PageLayer | null
  queued: string | null
  nextId: number
}

export const NO_PAGE_LAYERS: PageLayers = { shown: null, loading: null, queued: null, nextId: 0 }

export function offerPage(layers: PageLayers, html: string): PageLayers {
  const latest = layers.queued ?? layers.loading?.html ?? layers.shown?.html
  if (latest === html) return layers
  if (layers.loading) return { ...layers, queued: html }
  return { ...layers, loading: { id: layers.nextId, html }, nextId: layers.nextId + 1 }
}

export function pageLoaded(layers: PageLayers, id: number): PageLayers {
  const loaded = layers.loading
  if (loaded?.id !== id) return layers
  if (layers.queued === null || layers.queued === loaded.html)
    return { ...layers, shown: loaded, loading: null, queued: null }
  return {
    shown: loaded,
    loading: { id: layers.nextId, html: layers.queued },
    queued: null,
    nextId: layers.nextId + 1,
  }
}
