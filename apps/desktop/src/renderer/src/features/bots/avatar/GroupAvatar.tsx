import type { Avatar } from '@milibot/shared'

import { BotAvatar } from './BotAvatar'
import { clusterLayout } from './geometry'

export interface GroupMember {
  id: string
  avatar: Avatar
  state?: string | null
}

export function GroupAvatar({
  members,
  size = 36,
  animated = true,
  className = '',
}: {
  members: GroupMember[]
  size?: number
  animated?: boolean
  className?: string
}) {
  const layout = clusterLayout(members.length, size)
  return (
    <div className={`relative shrink-0 ${className}`} style={{ width: size, height: size }} aria-hidden>
      {layout.slots.map((slot, i) => {
        const member = members[i]
        if (!member) return null
        return (
          <div key={member.id} className="absolute" style={{ left: slot.x, top: slot.y }}>
            <BotAvatar avatar={member.avatar} state={member.state} size={slot.size} animated={animated} />
          </div>
        )
      })}
      {layout.more && (
        <span
          className="absolute flex items-center justify-center rounded-full bg-surface-3 font-bold text-fg-secondary"
          style={{
            left: layout.more.x,
            top: layout.more.y,
            width: layout.more.size,
            height: layout.more.size,
            fontSize: Math.max(7, Math.round(layout.more.size * 0.47)),
          }}
        >
          +{layout.more.count}
        </span>
      )}
    </div>
  )
}
