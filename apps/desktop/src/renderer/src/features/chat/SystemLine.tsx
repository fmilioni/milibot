import type { Bot, SystemPayload } from '@milibot/shared'
import {
  CalendarClock,
  CircleAlert,
  FolderOpen,
  GraduationCap,
  Hand,
  type LucideIcon,
  RefreshCw,
  Square,
  Trash2,
  UserMinus,
  UserPlus,
  Users,
} from 'lucide-react'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

import { NoticeCard, NoticeText } from '@/features/chat/cards/NoticeCard'
import { systemEventText } from '@/features/chat/lib/message-preview'

const SYSTEM_ICONS: Partial<Record<SystemPayload['event'], LucideIcon>> = {
  bot_created: UserPlus,
  turn_stopped: Square,
  user_took_control: Hand,
  user_released_control: Hand,
  max_steps_reached: CircleAlert,
  session_rotated: RefreshCw,
  group_created: Users,
  member_added: UserPlus,
  member_removed: UserMinus,
  bot_deleted: Trash2,
  routine_updated: CalendarClock,
  routine_deleted: Trash2,
  project_changed: FolderOpen,
}

export function SystemLine({
  payload,
  fallback,
  bots,
}: {
  payload: SystemPayload | null
  fallback: string
  bots: Record<string, Bot>
}) {
  const { t } = useTranslation()
  if (!payload) return <SystemRow>{fallback}</SystemRow>
  const Icon = SYSTEM_ICONS[payload.event]
  const text = systemEventText(payload, fallback, bots, t)
  if (payload.event === 'teach_started') {
    return (
      <NoticeCard tone="danger" icon={<GraduationCap size={14} className="shrink-0 text-danger" />}>
        <NoticeText>{text}</NoticeText>
      </NoticeCard>
    )
  }
  return <SystemRow icon={Icon ? <Icon size={12} /> : undefined}>{text}</SystemRow>
}

function SystemRow({ icon, children }: { icon?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex items-center justify-center gap-1.5 px-6 text-center text-sm text-fg-muted">
      {icon && <span className="shrink-0">{icon}</span>}
      <span>{children}</span>
    </div>
  )
}

export function UnreadDivider() {
  const { t } = useTranslation()
  return (
    <div className="flex items-center gap-2.5" role="separator" aria-label={t('chat.unreadDivider')}>
      <span className="h-px flex-1 bg-accent" />
      <span className="text-2xs leading-3 font-bold tracking-[0.08em] text-accent uppercase">
        {t('chat.unreadDivider')}
      </span>
      <span className="h-px flex-1 bg-accent" />
    </div>
  )
}
