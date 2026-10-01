import { useEffect, useLayoutEffect, useRef, useState } from 'react'

import {
  type Box,
  driftSeed,
  easeInOutCubic,
  glideMs,
  idleDrift,
  type Point,
  randomPointIn,
  sameCursorEntry,
} from '@/features/canvas/lib/bot-cursor'
import type { Viewport } from '@/lib/viewport'

/** One pass of the read scan (matches `.canvas-read-scan` in styles.css). */
export const READ_SCAN_MS = 2000
/** A cursor with no design activity for this long goes away even if its bot is still busy elsewhere. */
const CURSOR_IDLE_MS = 30_000
/** Opacity transition of a cursor appearing or going away (matches `duration-1000` below). */
const FADE_MS = 1000

/** Where a bot's cursor goes, in world coordinates. `key` changes = a new spot to glide to. */
export interface CursorGoal {
  key: string
  box: Box
}

export interface CursorEntry {
  botId: string
  name: string
  color: string
  goal: CursorGoal
  /** The bot is busy with this design (it disappears once it stops). */
  visible: boolean
  /** Last design activity of the bot (epoch ms); null while it works on it (each render counts as activity). */
  lastActivity: number | null
}

type StampedEntry = CursorEntry & { lastActivity: number }

interface CursorState {
  goalKey: string
  to: Point
  from: Point
  start: number
  duration: number
  pos: Point
  /** When it started fading out; null while shown. */
  hiddenAt: number | null
  seed: number
}

function destinationOf(box: Box, reduced: boolean): Point {
  return reduced ? { x: box.x + box.width / 2, y: box.y + box.height / 2 } : randomPointIn(box)
}

const faded = (state: CursorState, now: number) => state.hiddenAt !== null && now - state.hiddenAt >= FADE_MS

/**
 * Every bot that had a cursor stays, hidden once it leaves the list, so it fades out instead of vanishing.
 * The kept copy only changes (one extra render) when an entry's content does.
 */
export function useKnownEntries(entries: CursorEntry[]): CursorEntry[] {
  const [known, setKnown] = useState<ReadonlyMap<string, CursorEntry>>(() => new Map())
  if (entries.some((e) => !sameKnown(known.get(e.botId), e))) {
    const next = new Map(known)
    for (const entry of entries) next.set(entry.botId, entry)
    setKnown(next)
  }
  const current = new Map(entries.map((e) => [e.botId, e]))
  return [...known.values()].map((e) => current.get(e.botId) ?? { ...e, visible: false })
}

const sameKnown = (known: CursorEntry | undefined, entry: CursorEntry) =>
  known !== undefined && sameCursorEntry(known, entry)

/**
 * The cursors of the bots working on the design, in screen coordinates (they don't scale with the zoom): they
 * fade in and out, glide (ease in/out) to a random spot of what the bot just changed or reads and drift
 * slightly while it thinks.
 */
export function BotCursors({
  entries: current,
  viewport,
  reduced,
}: {
  entries: CursorEntry[]
  viewport: Viewport
  reduced: boolean
}) {
  const entries = useKnownEntries(current)
  const nodes = useRef(new Map<string, HTMLDivElement>())
  const states = useRef(new Map<string, CursorState>())
  const latest = useRef<{ entries: StampedEntry[]; viewport: Viewport; reduced: boolean }>({
    entries: [],
    viewport,
    reduced,
  })
  useLayoutEffect(() => {
    const now = Date.now()
    const stamped = entries.map((e) => ({ ...e, lastActivity: e.lastActivity ?? now }))
    latest.current = { entries: stamped, viewport, reduced }
  })

  const anyVisible = entries.some((e) => e.visible)
  useEffect(() => {
    if (!anyVisible) {
      const now = Date.now()
      for (const node of nodes.current.values()) node.style.opacity = '0'
      for (const state of states.current.values()) state.hiddenAt ??= now
      return
    }
    let frame = 0
    const step = () => {
      const { entries: list, viewport: v, reduced: still } = latest.current
      const now = Date.now()
      for (const botId of states.current.keys())
        if (!list.some((e) => e.botId === botId)) states.current.delete(botId)
      for (const entry of list) {
        const node = nodes.current.get(entry.botId)
        if (!node) continue
        let state = states.current.get(entry.botId)
        const visible = entry.visible && now - entry.lastActivity < CURSOR_IDLE_MS
        if (!state || state.goalKey !== entry.goal.key) {
          const to = destinationOf(entry.goal.box, still)
          const from = state && !faded(state, now) ? state.pos : to
          const distance = Math.hypot(to.x - from.x, to.y - from.y) * v.zoom
          state = {
            goalKey: entry.goal.key,
            to,
            from,
            start: now,
            duration: still ? 0 : glideMs(distance),
            pos: from,
            hiddenAt: state ? state.hiddenAt : now - FADE_MS,
            seed: state?.seed ?? driftSeed(entry.botId),
          }
          states.current.set(entry.botId, state)
        }
        if (visible && faded(state, now)) {
          // Appears where it is going, without gliding in from an old spot.
          state.from = state.to
          state.duration = 0
        }
        if (visible) state.hiddenAt = null
        else state.hiddenAt ??= now
        const k = state.duration > 0 ? easeInOutCubic((now - state.start) / state.duration) : 1
        const pos = {
          x: state.from.x + (state.to.x - state.from.x) * k,
          y: state.from.y + (state.to.y - state.from.y) * k,
        }
        state.pos = pos
        const drift = still ? { x: 0, y: 0 } : idleDrift(now, state.seed)
        const sx = pos.x * v.zoom + v.x + drift.x
        const sy = pos.y * v.zoom + v.y + drift.y
        node.style.transform = `translate3d(${sx}px, ${sy}px, 0)`
        node.style.opacity = visible ? '1' : '0'
      }
      frame = requestAnimationFrame(step)
    }
    frame = requestAnimationFrame(step)
    return () => cancelAnimationFrame(frame)
  }, [anyVisible])

  return entries.map((entry) => (
    <div
      key={entry.botId}
      ref={(node) => {
        // A new callback each render: React detaches and reattaches it, so the glide state lives elsewhere.
        if (node) nodes.current.set(entry.botId, node)
        else nodes.current.delete(entry.botId)
      }}
      aria-hidden
      className="pointer-events-none absolute top-0 left-0 transition-opacity duration-1000 ease-out will-change-transform"
      style={{ opacity: 0 }}
    >
      <svg
        width="18"
        height="18"
        viewBox="0 0 18 18"
        className="absolute -top-[2px] -left-[2px] drop-shadow-sm"
      >
        <path
          d="M2.6 1.9 16 8.1 9.7 10 6.9 16.2Z"
          fill={entry.color}
          stroke="white"
          strokeWidth="1.4"
          strokeLinejoin="round"
        />
      </svg>
      <span
        className="absolute top-[17px] left-[13px] rounded-[4px] px-1.5 py-px text-xs leading-[15px] font-medium whitespace-nowrap text-white shadow-[0_1px_3px_rgba(0,0,0,0.18)]"
        style={{ background: entry.color }}
      >
        {entry.name}
      </span>
    </div>
  ))
}
