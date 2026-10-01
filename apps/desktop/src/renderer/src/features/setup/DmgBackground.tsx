import type { Avatar } from '@milibot/shared'
import { useLayoutEffect } from 'react'

import { BotAvatar } from '@/features/bots/avatar/BotAvatar'

/*
 * Dev-only page (`#/dev/dmg-background?…`) captured by `scripts/dmg-background` into the macOS DMG
 * window's background. The icon layout comes from the query (`scripts/package/config.mjs` owns it).
 */

type Depth = 'near' | 'mid' | 'far'

/** Center in percent of the window, size in px at 1x, tilt in degrees. */
const FLOATING: Array<{ avatar: Avatar; x: number; y: number; size: number; tilt: number; depth: Depth }> = [
  {
    avatar: { shape: 'arch', color: 'violet', eyes: 'capsule' },
    x: 10,
    y: 17,
    size: 56,
    tilt: -6,
    depth: 'near',
  },
  {
    avatar: { shape: 'triangle', color: 'pink', eyes: 'capsule' },
    x: 31,
    y: 11,
    size: 28,
    tilt: 10,
    depth: 'far',
  },
  { avatar: { shape: 'blob', color: 'green', eyes: 'oval' }, x: 50, y: 15, size: 42, tilt: 4, depth: 'mid' },
  {
    avatar: { shape: 'cloud', color: 'blue', eyes: 'capsule' },
    x: 69,
    y: 9,
    size: 24,
    tilt: 0,
    depth: 'far',
  },
  {
    avatar: { shape: 'drop', color: 'orange', eyes: 'capsule' },
    x: 89,
    y: 17,
    size: 60,
    tilt: 8,
    depth: 'near',
  },
  {
    avatar: { shape: 'shield', color: 'gray', eyes: 'capsule' },
    x: 5,
    y: 52,
    size: 30,
    tilt: -4,
    depth: 'far',
  },
  {
    avatar: { shape: 'diamond', color: 'amber', eyes: 'oval' },
    x: 95.5,
    y: 50,
    size: 34,
    tilt: -8,
    depth: 'mid',
  },
  {
    avatar: { shape: 'square', color: 'teal', eyes: 'capsule' },
    x: 13,
    y: 86,
    size: 58,
    tilt: -10,
    depth: 'near',
  },
  {
    avatar: { shape: 'ghost', color: 'red', eyes: 'capsule' },
    x: 36,
    y: 90,
    size: 34,
    tilt: 0,
    depth: 'mid',
  },
  {
    avatar: { shape: 'hexagon', color: 'blue', eyes: 'capsule' },
    x: 59,
    y: 92,
    size: 24,
    tilt: 6,
    depth: 'far',
  },
  { avatar: { shape: 'tv', color: 'pink', eyes: 'capsule' }, x: 84, y: 85, size: 62, tilt: 6, depth: 'near' },
]

const DEPTH_STYLE: Record<Depth, { opacity: number; filter?: string }> = {
  near: { opacity: 1 },
  mid: { opacity: 0.75, filter: 'blur(0.6px)' },
  far: { opacity: 0.42, filter: 'blur(1.4px)' },
}

interface Layout {
  width: number
  height: number
  chrome: number
  iconSize: number
  app: [number, number]
  applications: [number, number]
}

function point(value: string | null, fallback: [number, number]): [number, number] {
  const [x, y] = (value ?? '').split(',').map(Number)
  return x != null && y != null && Number.isFinite(x) && Number.isFinite(y) ? [x, y] : fallback
}

function parseDmgLayout(params: URLSearchParams): Layout {
  const number = (key: string, fallback: number) => Number(params.get(key)) || fallback
  return {
    width: number('width', 660),
    height: number('height', 400),
    chrome: number('chrome', 0),
    iconSize: number('iconSize', 112),
    app: point(params.get('app'), [170, 190]),
    applications: point(params.get('applications'), [490, 190]),
  }
}

/**
 * Finder draws the icon labels in the system appearance's colour (black or white) whatever the background,
 * so each label sits on a mid-tone pedestal that keeps both readable.
 */
function Pedestal({ x, y, iconSize }: { x: number; y: number; iconSize: number }) {
  const width = iconSize + 16
  return (
    <div
      className="absolute rounded-full"
      style={{
        left: x - width / 2,
        top: y + iconSize / 2,
        width,
        height: 26,
        background: 'linear-gradient(#7a8193, #717888)',
        boxShadow: 'inset 0 1px 0 rgb(255 255 255 / 0.12), 0 4px 14px rgb(0 0 0 / 0.35)',
      }}
    />
  )
}

function Arrow({ from, to, iconSize }: { from: [number, number]; to: [number, number]; iconSize: number }) {
  const start = from[0] + iconSize / 2 + 26
  const end = to[0] - iconSize / 2 - 26
  const y = (from[1] + to[1]) / 2
  const lift = 14
  return (
    <svg className="absolute inset-0" width="100%" height="100%" aria-hidden>
      <path
        d={`M${start} ${y} Q${(start + end) / 2} ${y - lift} ${end} ${y}`}
        fill="none"
        stroke="var(--text-secondary)"
        strokeOpacity={0.55}
        strokeWidth={2.5}
        strokeLinecap="round"
        strokeDasharray="1 9"
      />
      <path
        d={`M${end - 11} ${y - 9} L${end} ${y} L${end - 12} ${y + 5}`}
        fill="none"
        stroke="var(--text-secondary)"
        strokeOpacity={0.7}
        strokeWidth={2.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

export function DmgBackground({ params }: { params: URLSearchParams }) {
  const layout = parseDmgLayout(params)
  const { width, height, chrome, iconSize, app, applications } = layout

  useLayoutEffect(() => {
    document.documentElement.dataset.theme = 'dark'
  }, [])

  return (
    <div
      data-dmg-ready
      className="relative overflow-hidden"
      style={{
        width,
        height: height + chrome,
        background: [
          `radial-gradient(${width * 0.55}px ${height * 0.6}px at ${width / 2}px ${height * 0.48}px, color-mix(in srgb, var(--accent) 16%, transparent), transparent 70%)`,
          `radial-gradient(${width * 0.9}px ${height * 0.8}px at ${width / 2}px ${height / 2}px, var(--surface-2), var(--bg) 85%)`,
          'var(--bg)',
        ].join(', '),
      }}
    >
      <div className="absolute inset-x-0 top-0" style={{ height }}>
        {FLOATING.map((item) => (
          <div
            key={item.avatar.shape}
            className="absolute"
            style={{
              left: `${item.x}%`,
              top: `${item.y}%`,
              transform: `translate(-50%, -50%) rotate(${item.tilt}deg)`,
              ...DEPTH_STYLE[item.depth],
            }}
          >
            <BotAvatar avatar={item.avatar} size={item.size} animated={false} />
          </div>
        ))}
        <Arrow from={app} to={applications} iconSize={iconSize} />
        <Pedestal x={app[0]} y={app[1]} iconSize={iconSize} />
        <Pedestal x={applications[0]} y={applications[1]} iconSize={iconSize} />
      </div>
    </div>
  )
}
