import { type Avatar, AVATAR_COLORS, AVATAR_EYES, AVATAR_SHAPES, type AvatarColor } from '@milibot/shared'
import { useEffect, useState } from 'react'

import { cn } from '@/lib/cn'

import { BotAvatar } from './BotAvatar'
import { GroupAvatar } from './GroupAvatar'
import { AVATAR_STATES, type AvatarState } from './motion-model'

/* Dev-only review page (`#/dev/avatars`); strings are intentionally not translated. */

const COLORS_BY_SHAPE: AvatarColor[] = [
  'blue',
  'gray',
  'orange',
  'teal',
  'pink',
  'red',
  'green',
  'violet',
  'gray',
  'amber',
]

export function AvatarGallery() {
  const [state, setState] = useState<AvatarState>('idle')
  const [cycle, setCycle] = useState(false)
  const [size, setSize] = useState(64)

  useEffect(() => {
    if (!cycle) return
    const id = setInterval(() => {
      setState((s) => AVATAR_STATES[(AVATAR_STATES.indexOf(s) + 1) % AVATAR_STATES.length] as AvatarState)
    }, 1600)
    return () => clearInterval(id)
  }, [cycle])

  const members = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      id: String(i),
      avatar: {
        shape: AVATAR_SHAPES[(i * 3) % AVATAR_SHAPES.length],
        color: AVATAR_COLORS[(i * 7) % AVATAR_COLORS.length],
        eyes: AVATAR_EYES[i % AVATAR_EYES.length],
      } as Avatar,
      state,
    }))

  return (
    <div className="selectable h-full overflow-y-auto bg-bg p-10 text-fg" data-testid="avatar-gallery">
      <h1 className="mb-6 text-4xl font-bold">BotAvatar — gallery</h1>
      <div className="mb-8 flex flex-wrap items-center gap-2">
        {AVATAR_STATES.map((s) => (
          <button
            key={s}
            type="button"
            data-state={s}
            onClick={() => setState(s)}
            className={cn(
              'rounded-lg px-3 py-1.5 text-base',
              s === state ? 'bg-accent text-on-accent' : 'bg-surface-3',
            )}
          >
            {s}
          </button>
        ))}
        <label className="ml-4 flex items-center gap-2 text-base">
          <input type="checkbox" checked={cycle} onChange={(e) => setCycle(e.target.checked)} /> cycle
        </label>
        <label className="ml-4 flex items-center gap-2 text-base">
          size
          <input
            type="range"
            min={14}
            max={128}
            value={size}
            onChange={(e) => setSize(Number(e.target.value))}
          />
          {size}
        </label>
        <div className="ml-2 flex items-center gap-1">
          {[14, 24, 56, 128].map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setSize(s)}
              className={cn(
                'rounded-md px-2 py-1 text-sm',
                s === size ? 'bg-accent text-on-accent' : 'bg-surface-3',
              )}
            >
              {s}
            </button>
          ))}
        </div>
      </div>

      <section className="mb-10">
        <h2 className="mb-3 text-base font-semibold text-fg-secondary">
          Shapes × eyes ({state}, {size}px)
        </h2>
        <table className="border-separate border-spacing-x-6 border-spacing-y-3">
          <thead>
            <tr>
              <th />
              {AVATAR_EYES.map((eyes) => (
                <th key={eyes} className="text-left text-xs font-medium text-fg-muted">
                  {eyes}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {AVATAR_SHAPES.map((shape, i) => (
              <tr key={shape}>
                <td className="text-xs text-fg-muted">{shape}</td>
                {AVATAR_EYES.map((eyes) => (
                  <td key={eyes}>
                    <BotAvatar
                      avatar={{ shape, color: COLORS_BY_SHAPE[i] ?? 'blue', eyes }}
                      state={state}
                      size={size}
                    />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="mb-10">
        <h2 className="mb-3 text-base font-semibold text-fg-secondary">Eyes × states</h2>
        <table className="border-separate border-spacing-x-6 border-spacing-y-3">
          <thead>
            <tr>
              <th />
              {AVATAR_STATES.map((s) => (
                <th key={s} className="text-left text-xs font-medium text-fg-muted">
                  {s}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {AVATAR_EYES.map((eyes) => (
              <tr key={eyes}>
                <td className="text-xs text-fg-muted">{eyes}</td>
                {AVATAR_STATES.map((s) => (
                  <td key={s}>
                    <BotAvatar avatar={{ shape: 'square', color: 'blue', eyes }} state={s} size={56} />
                  </td>
                ))}
              </tr>
            ))}
            {(['square', 'drop'] as const).map((shape) => (
              <tr key={shape}>
                <td className="text-xs text-fg-muted">{shape}</td>
                {AVATAR_STATES.map((s) => (
                  <td key={s}>
                    <BotAvatar
                      avatar={{ shape, color: shape === 'drop' ? 'orange' : 'teal', eyes: 'capsule' }}
                      state={s}
                      size={56}
                    />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="mb-10">
        <h2 className="mb-3 text-base font-semibold text-fg-secondary">Colors</h2>
        <div className="flex gap-3">
          {AVATAR_COLORS.map((color) => (
            <BotAvatar
              key={color}
              avatar={{ shape: 'square', color, eyes: 'capsule' }}
              state={state}
              size={36}
            />
          ))}
        </div>
      </section>

      <section>
        <h2 className="mb-3 text-base font-semibold text-fg-secondary">Groups (2, 3, 4, 5, 8 members)</h2>
        <div className="flex items-center gap-6">
          {[2, 3, 4, 5, 8].map((n) => (
            <GroupAvatar key={n} members={members(n)} size={36} />
          ))}
          {[3, 5].map((n) => (
            <GroupAvatar key={`l${n}`} members={members(n)} size={72} />
          ))}
        </div>
      </section>
    </div>
  )
}
