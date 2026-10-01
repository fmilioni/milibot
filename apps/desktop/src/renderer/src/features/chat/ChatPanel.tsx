import type { Bot, ConversationSummary } from '@milibot/shared'
import { Bug, Eye, Monitor, Paperclip, SlidersHorizontal, Users } from 'lucide-react'
import { type DragEvent, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { BotAvatar } from '@/features/bots/avatar/BotAvatar'
import { GroupAvatar } from '@/features/bots/avatar/GroupAvatar'
import { botStatusLabel, waitingForUser } from '@/features/bots/lib/bot-status'
import { useFrameAsk } from '@/features/canvas/use-frame-ask'
import { describeConversation, STATUS_DOT_CLASS } from '@/features/chat/lib/conversation'
import { DesignPresenceChip } from '@/features/designs/DesignPresenceChip'
import { DesignsButton } from '@/features/designs/DesignsButton'
import { useTeachingBot } from '@/features/vm/teach-store'
import { useAppStore, useSelectedConversation } from '@/features/workspace/store'
import { useWorkspaceId } from '@/features/workspace/use-workspace-id'
import { cn } from '@/lib/cn'
import { IconButton } from '@/ui/IconButton'
import { META_SEPARATOR, MetaText } from '@/ui/MetaText'

import { useAttachmentStore } from './attachment-store'
import { Composer } from './Composer'
import { MessageList } from './MessageList'
import { ProjectChip } from './ProjectChip'
import { StarterSuggestions } from './StarterSuggestions'

export function ChatPanel() {
  const { t } = useTranslation()
  const conversation = useSelectedConversation()
  const bots = useAppStore((s) => s.bots)
  const addFiles = useAttachmentStore((s) => s.addFiles)
  const workspaceId = useWorkspaceId()
  const [dragging, setDragging] = useState(false)
  const dragDepth = useRef(0)

  if (!conversation) {
    return (
      <main className="flex min-w-0 flex-1 flex-col bg-bg">
        <div className="drag-region h-16 shrink-0 border-b border-border" />
        <div className="flex flex-1 items-center justify-center text-md leading-5 text-fg-muted">
          {t('chat.noConversation')}
        </div>
      </main>
    )
  }

  const display = describeConversation(conversation, bots, t('sidebar.groupFallback'))
  const internal = conversation.type === 'internal'
  const hasFiles = (event: DragEvent) => !internal && event.dataTransfer.types.includes('Files')
  const dropHandlers = {
    onDragEnter: (event: DragEvent) => {
      if (!hasFiles(event)) return
      event.preventDefault()
      dragDepth.current++
      setDragging(true)
    },
    onDragOver: (event: DragEvent) => {
      if (!hasFiles(event)) return
      event.preventDefault()
      event.dataTransfer.dropEffect = 'copy'
    },
    onDragLeave: (event: DragEvent) => {
      if (!hasFiles(event)) return
      dragDepth.current = Math.max(0, dragDepth.current - 1)
      if (dragDepth.current === 0) setDragging(false)
    },
    onDrop: (event: DragEvent) => {
      if (!hasFiles(event)) return
      event.preventDefault()
      dragDepth.current = 0
      setDragging(false)
      const files = Array.from(event.dataTransfer.files)
      if (files.length) addFiles(workspaceId, conversation.id, files)
    },
  }

  return (
    <main
      className="relative flex min-w-0 flex-1 flex-col bg-bg"
      aria-label={display.title}
      {...dropHandlers}
    >
      {dragging && (
        <div className="pointer-events-none absolute inset-3 z-overlay flex flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-accent bg-bg/90 text-accent shadow-[inset_0_0_0_9999px_var(--accent-soft)]">
          <Paperclip size={22} />
          <span className="text-md font-semibold">
            {t('chat.attachments.dropTitle', { name: display.title })}
          </span>
          <span className="text-sm text-fg-secondary">{t('chat.attachments.dropHint')}</span>
        </div>
      )}
      <ChatHeader conversation={conversation} bots={bots} />
      {internal && (
        <div className="flex items-center gap-2 border-b border-border bg-surface px-5 py-2 text-sm text-fg-secondary">
          <Eye size={13} className="shrink-0 text-fg-muted" />
          {t('chat.internalReadOnly')}
        </div>
      )}
      <MessageList
        conversationId={conversation.id}
        bots={bots}
        emptyName={display.title}
        emptyBot={display.primaryBot}
        showRoleChips={conversation.type !== 'direct'}
      />
      {!internal && <StarterSuggestions conversation={conversation} />}
      {!internal && <DesignPresenceChip conversationId={conversation.id} members={display.members} />}
      {!internal && (
        <ChatComposer conversationId={conversation.id} targetName={display.title} members={display.members} />
      )}
    </main>
  )
}

function ChatHeader({
  conversation,
  bots,
}: {
  conversation: ConversationSummary
  bots: Record<string, Bot>
}) {
  const { t } = useTranslation()
  const rightPanel = useAppStore((s) => s.rightPanel)
  const toggle = useAppStore((s) => s.toggleRightPanel)
  const statusDetail = useAppStore((s) => s.statusDetail)
  const display = describeConversation(conversation, bots, t('sidebar.groupFallback'))
  const bot = display.primaryBot
  const teaching = useTeachingBot(bot?.id)

  const waiting = bot && !teaching ? waitingForUser(bot.status, statusDetail[bot.id]) : null
  let subtitle: string
  if (bot && teaching) {
    subtitle = t('chat.teachStatus')
  } else if (waiting) {
    subtitle = t(`bot.waiting.${waiting}`)
  } else if (bot) {
    subtitle = botStatusLabel(bot.status, statusDetail[bot.id], t, bots)
  } else {
    const names = [t('chat.you'), ...display.members.map((m) => m.name)].join(', ')
    const busy = display.members.filter((m) => m.status !== 'idle')
    subtitle = busy.length
      ? `${names}${META_SEPARATOR}${busy.map((m) => t('chat.memberStatus', { name: m.name, status: botStatusLabel(m.status, statusDetail[m.id], t, bots).toLocaleLowerCase() })).join(', ')}`
      : names
  }

  return (
    <header
      className={cn(
        'drag-region flex h-16 shrink-0 items-center justify-between gap-4 border-b border-border px-5',
        !rightPanel && 'win:pr-caption-5',
      )}
    >
      <div className="flex min-w-0 items-center gap-3">
        {bot ? (
          <BotAvatar avatar={bot.avatar} state={bot.status} size={34} />
        ) : (
          <GroupAvatar
            members={display.members.map((m) => ({ id: m.id, avatar: m.avatar, state: m.status }))}
            size={34}
          />
        )}
        <div className="flex min-w-0 flex-col gap-[3px]">
          <h1 className="truncate text-lg leading-[18px] font-semibold text-fg">{display.title}</h1>
          <span className="flex items-center gap-1.5 text-sm leading-4 text-fg-secondary">
            {bot && (
              <span
                className={cn(
                  'size-1.5 shrink-0 rounded-full',
                  teaching
                    ? 'bg-danger'
                    : waiting
                      ? 'bg-warning'
                      : (STATUS_DOT_CLASS[bot.status] ?? 'bg-fg-muted'),
                )}
              />
            )}
            <span className="truncate">
              <MetaText text={subtitle} />
            </span>
          </span>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        {conversation.type !== 'internal' && <ProjectChip conversation={conversation} />}
        {conversation.type !== 'internal' && <DesignsButton conversation={conversation} />}
        {conversation.type === 'group' && (
          <IconButton
            label={t('chat.showMembers')}
            active={rightPanel === 'members'}
            onClick={() => toggle('members')}
          >
            <Users size={15} />
          </IconButton>
        )}
        <IconButton label={t('chat.showVm')} active={rightPanel === 'vm'} onClick={() => toggle('vm')}>
          <Monitor size={15} />
        </IconButton>
        <IconButton
          label={t('chat.showDebug')}
          active={rightPanel === 'debug'}
          onClick={() => toggle('debug')}
        >
          <Bug size={15} />
        </IconButton>
        {bot && (
          <IconButton
            label={t('chat.botSettings')}
            active={rightPanel === 'bot'}
            onClick={() => toggle('bot')}
          >
            <SlidersHorizontal size={15} />
          </IconButton>
        )}
      </div>
    </header>
  )
}

/** The chat's composer; "Ask for a change" on a canvas frame leaves its chip here too. */
function ChatComposer(props: { conversationId: string; targetName: string; members: Bot[] }) {
  const context = useFrameAsk(props.conversationId)
  return <Composer {...props} context={context} />
}
