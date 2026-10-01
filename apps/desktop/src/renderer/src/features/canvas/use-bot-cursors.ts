import type { Bot, PlacedFrame } from '@milibot/shared'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'

import { type Box, clampBox } from '@/features/canvas/lib/bot-cursor'
import type { FrameDraft } from '@/features/canvas/lib/design-drafts'

import { type CursorEntry, type CursorGoal, READ_SCAN_MS } from './BotCursor'
import type { PresenceByBot } from './store'

/** After its write ends, a frame still reports its changes this long (the new page loads after the event). */
const WRITE_LINGER_MS = 4000

interface Mark {
  box: Box
  at: number
}

export interface ReadScan {
  botId: string
  since: number
}

/**
 * The cursors of the bots on a design and what feeds them: the frames being changed (whose new versions report
 * where they changed), the frames being read (a scan each) and the changed spots of drafts and frames.
 */
export function useBotCursors({
  bots,
  presences,
  drafts,
  draftRects,
  rects,
  colorOf,
}: {
  bots: Record<string, Bot>
  presences: PresenceByBot | undefined
  drafts: FrameDraft[]
  draftRects: PlacedFrame[]
  rects: PlacedFrame[]
  colorOf: (botId: string) => string
}) {
  const [marks, setMarks] = useState<Record<string, Mark>>({})
  const [now, setNow] = useState(() => Date.now())
  const list = Object.values(presences ?? {}).flatMap((p) => (p ? [p] : []))

  const writers = new Map<string, string>()
  const scans = new Map<string, ReadScan>()
  for (const p of list) {
    if (!p.frameId) continue
    if (p.mode === 'write' && (p.active || now - p.at < WRITE_LINGER_MS)) writers.set(p.frameId, p.botId)
    if (p.mode === 'read' && (p.active || now - p.since < READ_SCAN_MS))
      scans.set(p.frameId, { botId: p.botId, since: p.since })
  }

  const wakeTimes = list.flatMap((p) => {
    if (p.active) return []
    const end = p.mode === 'read' ? p.since + READ_SCAN_MS : p.at + WRITE_LINGER_MS
    return end > now ? [end] : []
  })
  const nextWake = wakeTimes.length ? Math.min(...wakeTimes) : null
  useEffect(() => {
    if (nextWake === null) return
    const timer = setTimeout(() => setNow(Date.now()), nextWake - Date.now() + 20)
    return () => clearTimeout(timer)
  }, [nextWake])

  const latest = useRef({ drafts, draftRects, rects, writers })
  useLayoutEffect(() => {
    latest.current = { drafts, draftRects, rects, writers }
  })
  const mark = (botId: string, box: Box | null) => {
    if (box) setMarks((current) => ({ ...current, [botId]: { box, at: Date.now() } }))
  }
  const markDraft = useCallback((draftId: string, box: Box) => {
    const { drafts: all, draftRects: placed } = latest.current
    const draft = all.find((d) => d.draftId === draftId)
    const rect = placed.find((r) => r.id === draftId)
    if (!draft || !rect) return
    // A draft grows with its content: its placed height still lags the version that just loaded.
    const bounds = { ...rect, height: Math.max(rect.height, box.y + box.height) }
    mark(draft.botId, clampBox({ ...box, x: box.x + rect.x, y: box.y + rect.y }, bounds))
  }, [])
  const markFrame = useCallback((frameId: string, box: Box) => {
    const botId = latest.current.writers.get(frameId)
    const rect = latest.current.rects.find((r) => r.id === frameId)
    if (botId && rect) mark(botId, clampBox({ ...box, x: box.x + rect.x, y: box.y + rect.y }, rect))
  }, [])

  const botIds = new Set([...list.map((p) => p.botId), ...drafts.map((d) => d.botId), ...Object.keys(marks)])
  const entries: CursorEntry[] = [...botIds].flatMap((botId) => {
    const p = presences?.[botId]
    const draft = drafts.filter((d) => d.botId === botId).sort((a, b) => b.at - a.at)[0]
    const draftRect = draft && draftRects.find((r) => r.id === draft.draftId)
    const own = marks[botId]
    const frameRect = p?.frameId ? rects.find((r) => r.id === p.frameId) : undefined
    let goal: CursorGoal | null = null
    const reading: CursorGoal | null =
      p?.mode === 'read' && frameRect ? { key: `read:${p.since}`, box: frameRect } : null
    if (reading && scans.get(frameRect?.id ?? '')?.botId === botId) goal = reading
    else if (own && own.at >= (p?.since ?? 0)) goal = { key: `mark:${own.at}`, box: own.box }
    else if (p?.mode === 'write' && frameRect) goal = { key: `frame:${p.since}`, box: frameRect }
    else if (draftRect) goal = { key: `draft:${draft.draftId}`, box: draftRect }
    else if (reading) goal = reading
    else if (own) goal = { key: `mark:${own.at}`, box: own.box }
    if (!goal) return []
    const bot = bots[botId]
    const busy = Boolean(bot && bot.status !== 'idle' && bot.status !== 'paused')
    const working = Boolean(p?.active || draft)
    return [
      {
        botId,
        name: bot?.name ?? '…',
        color: colorOf(botId),
        goal,
        visible: working || busy,
        lastActivity: working ? null : Math.max(p?.at ?? 0, own?.at ?? 0),
      },
    ]
  })

  return { entries, writers, scans, markDraft, markFrame }
}
