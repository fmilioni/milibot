import type { DesignFrame, WorkspaceEvent } from '@milibot/shared'
import { describe, expect, it } from 'vitest'

import {
  applyDraftEvent,
  DRAFT_TTL_MS,
  type DraftsByDesign,
  type FrameDraftEvent,
  nextDraftExpiry,
  NO_PAGE_LAYERS,
  offerPage,
  pageLoaded,
  pruneDrafts,
} from './design-drafts'

const draft = (patch: Partial<FrameDraftEvent> = {}): WorkspaceEvent => ({
  type: 'design.frame.draft',
  payload: {
    designId: 'dsg_1',
    draftId: 'trn_1:1',
    botId: 'bot_1',
    frameId: null,
    name: 'Profile',
    x: 470,
    y: 0,
    width: 390,
    height: null,
    theme: 'Light',
    html: '<!doctype html><p>Hel',
    ...patch,
  },
})

const frame = (patch: Partial<DesignFrame>): DesignFrame =>
  ({ id: 'dfr_1', name: 'Home', x: 0, y: 0, width: 390, height: 844, ...patch }) as DesignFrame

describe('design drafts', () => {
  it('keeps the latest version of each draft per design', () => {
    let drafts: DraftsByDesign = {}
    drafts = applyDraftEvent(drafts, draft(), 1000)
    drafts = applyDraftEvent(drafts, draft({ html: '<!doctype html><p>Hello</p>' }), 1500)
    drafts = applyDraftEvent(drafts, draft({ draftId: 'trn_1:2', frameId: 'dfr_1', name: 'Home' }), 1600)
    expect(Object.keys(drafts.dsg_1 ?? {})).toEqual(['trn_1:1', 'trn_1:2'])
    expect(drafts.dsg_1?.['trn_1:1']).toMatchObject({ html: '<!doctype html><p>Hello</p>', at: 1500 })
    expect(applyDraftEvent(drafts, { type: 'design.deleted', payload: { designId: 'dsg_9' } }, 0)).toBe(
      drafts,
    )
  })

  it('drops a draft when cleared, when its frame is written or when the design goes away', () => {
    let drafts: DraftsByDesign = {}
    drafts = applyDraftEvent(drafts, draft(), 0)
    drafts = applyDraftEvent(drafts, draft({ draftId: 'd2', frameId: 'dfr_1', name: 'Home' }), 0)
    drafts = applyDraftEvent(drafts, draft({ draftId: 'd3', name: 'Cart' }), 0)

    const updated = (f: DesignFrame): WorkspaceEvent => ({
      type: 'design.frame.updated',
      payload: { designId: 'dsg_1', frame: f, deleted: false },
    })
    drafts = applyDraftEvent(drafts, updated(frame({ id: 'dfr_1', name: 'Landing' })), 0)
    expect(Object.keys(drafts.dsg_1 ?? {})).toEqual(['trn_1:1', 'd3'])
    drafts = applyDraftEvent(drafts, updated(frame({ id: 'dfr_2', name: ' profile ' })), 0)
    expect(Object.keys(drafts.dsg_1 ?? {})).toEqual(['d3'])
    const unchanged = applyDraftEvent(drafts, updated(frame({ id: 'dfr_3', name: 'Other' })), 0)
    expect(unchanged).toBe(drafts)

    drafts = applyDraftEvent(
      drafts,
      { type: 'design.frame.draft.cleared', payload: { designId: 'dsg_1', draftId: 'd3' } },
      0,
    )
    expect(drafts).toEqual({})

    drafts = applyDraftEvent(drafts, draft(), 0)
    expect(applyDraftEvent(drafts, { type: 'design.deleted', payload: { designId: 'dsg_1' } }, 0)).toEqual({})
  })

  it('expires drafts that stopped growing', () => {
    let drafts: DraftsByDesign = {}
    drafts = applyDraftEvent(drafts, draft(), 1000)
    drafts = applyDraftEvent(drafts, draft({ draftId: 'd2' }), 5000)
    expect(nextDraftExpiry(drafts)).toBe(1000 + DRAFT_TTL_MS)
    expect(pruneDrafts(drafts, 2000)).toBe(drafts)
    const pruned = pruneDrafts(drafts, 1000 + DRAFT_TTL_MS)
    expect(Object.keys(pruned.dsg_1 ?? {})).toEqual(['d2'])
    expect(pruneDrafts(pruned, 5000 + DRAFT_TTL_MS)).toEqual({})
    expect(nextDraftExpiry({})).toBeNull()
  })
})

describe('draft page layers', () => {
  it('keeps loading the first version while newer ones arrive, then loads only the newest', () => {
    let layers = offerPage(NO_PAGE_LAYERS, 'v1')
    expect(layers.loading).toEqual({ id: 0, html: 'v1' })
    layers = offerPage(offerPage(layers, 'v2'), 'v3')
    expect(layers.loading).toEqual({ id: 0, html: 'v1' })
    expect(layers.queued).toBe('v3')
    layers = pageLoaded(layers, 0)
    expect(layers.shown).toEqual({ id: 0, html: 'v1' })
    expect(layers.loading).toEqual({ id: 1, html: 'v3' })
    expect(layers.queued).toBeNull()
    layers = pageLoaded(layers, 1)
    expect(layers).toEqual({ shown: { id: 1, html: 'v3' }, loading: null, queued: null, nextId: 2 })
  })

  it('ignores the version already on its way and stale loads', () => {
    const shown = pageLoaded(offerPage(NO_PAGE_LAYERS, 'v1'), 0)
    expect(offerPage(shown, 'v1')).toBe(shown)
    const loading = offerPage(shown, 'v2')
    expect(offerPage(loading, 'v2')).toBe(loading)
    expect(pageLoaded(loading, 0)).toBe(loading)
  })
})
