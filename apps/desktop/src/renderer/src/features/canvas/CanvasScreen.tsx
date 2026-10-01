import { ArrowLeft, PanelLeftClose, PanelLeftOpen } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { BotAvatar } from '@/features/bots/avatar/BotAvatar'
import { GroupAvatar } from '@/features/bots/avatar/GroupAvatar'
import { botStatusLabel } from '@/features/bots/lib/bot-status'
import { Composer } from '@/features/chat/Composer'
import { describeConversation, STATUS_DOT_CLASS } from '@/features/chat/lib/conversation'
import { MessageList } from '@/features/chat/MessageList'
import { Sidebar } from '@/features/sidebar/Sidebar'
import { type CanvasScreen as CanvasScreenState, useAppStore } from '@/features/workspace/store'
import { cn } from '@/lib/cn'
import { Tooltip } from '@/ui/Tooltip'

import { CanvasView } from './CanvasView'
import { useFrameAsk } from './use-frame-ask'

const CHAT_WIDTH = 380

/** A design's canvas full window: its conversation in a narrow column on the left. */
export function CanvasScreen() {
  const screen = useAppStore((s) => s.screen) as CanvasScreenState
  const conversationId = useAppStore((s) => s.selectedConversationId)
  const closeCanvas = useAppStore((s) => s.closeCanvas)
  const openCanvas = useAppStore((s) => s.openCanvas)
  return (
    <>
      {screen.sidebar && <Sidebar />}
      {conversationId && <CanvasChat conversationId={conversationId} sidebar={screen.sidebar} />}
      <CanvasView
        designId={screen.designId}
        conversationId={conversationId}
        onClose={closeCanvas}
        onSwitch={(designId) => void openCanvas(designId, conversationId)}
      />
    </>
  )
}

function CanvasChat({ conversationId, sidebar }: { conversationId: string; sidebar: boolean }) {
  const { t } = useTranslation()
  const conversation = useAppStore((s) => s.conversations[conversationId])
  const bots = useAppStore((s) => s.bots)
  const statusDetail = useAppStore((s) => s.statusDetail)
  const toggleSidebar = useAppStore((s) => s.toggleCanvasSidebar)
  const closeCanvas = useAppStore((s) => s.closeCanvas)
  const context = useFrameAsk(conversationId)
  if (!conversation) return null
  const display = describeConversation(conversation, bots, t('sidebar.groupFallback'))
  const bot = display.primaryBot
  const status = bot
    ? botStatusLabel(bot.status, statusDetail[bot.id], t, bots)
    : display.members.map((m) => m.name).join(', ')
  const internal = conversation.type === 'internal'

  return (
    <section
      className="flex shrink-0 flex-col border-r border-border bg-bg"
      style={{ width: CHAT_WIDTH }}
      aria-label={display.title}
    >
      <header
        className={cn(
          'drag-region flex h-14 shrink-0 items-center gap-2.5 border-b border-border pr-3.5',
          sidebar ? 'pl-3.5' : 'pl-3.5 mac:pl-[84px]',
        )}
      >
        <Tooltip content={sidebar ? t('canvas.hideSidebar') : t('canvas.showSidebar')}>
          <button
            type="button"
            onClick={toggleSidebar}
            aria-label={sidebar ? t('canvas.hideSidebar') : t('canvas.showSidebar')}
            className="no-drag focus-ring flex size-6 shrink-0 items-center justify-center rounded-md text-fg-secondary hover:bg-surface-3"
          >
            {sidebar ? <PanelLeftClose size={16} /> : <PanelLeftOpen size={16} />}
          </button>
        </Tooltip>
        <Tooltip content={t('canvas.back')}>
          <button
            type="button"
            onClick={closeCanvas}
            aria-label={t('canvas.back')}
            className="no-drag focus-ring flex size-6 shrink-0 items-center justify-center rounded-md text-fg-secondary hover:bg-surface-3"
          >
            <ArrowLeft size={16} />
          </button>
        </Tooltip>
        {bot ? (
          <BotAvatar avatar={bot.avatar} state={bot.status} size={28} />
        ) : (
          <GroupAvatar
            members={display.members.map((m) => ({ id: m.id, avatar: m.avatar, state: m.status }))}
            size={28}
          />
        )}
        <div className="flex min-w-0 flex-1 flex-col gap-px">
          <h1 className="truncate text-md leading-[17px] font-semibold text-fg">{display.title}</h1>
          <span className="flex min-w-0 items-center gap-[5px] text-xs text-fg-secondary">
            {bot && (
              <span
                className={cn(
                  'size-1.5 shrink-0 rounded-full',
                  STATUS_DOT_CLASS[bot.status] ?? 'bg-fg-muted',
                )}
              />
            )}
            <span className="truncate">{status}</span>
          </span>
        </div>
      </header>
      <MessageList
        conversationId={conversation.id}
        bots={bots}
        emptyName={display.title}
        emptyBot={display.primaryBot}
        showRoleChips={conversation.type !== 'direct'}
      />
      {!internal && (
        <Composer
          conversationId={conversation.id}
          targetName={display.title}
          members={display.members}
          context={context}
          placeholder={t('canvas.composerPlaceholder')}
          wide={false}
        />
      )}
    </section>
  )
}
