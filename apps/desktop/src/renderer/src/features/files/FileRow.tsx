import type { ChatFile } from '@milibot/shared'
import {
  Download,
  File,
  FileArchive,
  FileText,
  FolderOpen,
  Image as ImageIcon,
  type LucideIcon,
  MessageCircle,
  MessageSquare,
  Pencil,
  SquareArrowOutUpRight,
  Trash2,
  User,
  Users,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { BotAvatar } from '@/features/bots/avatar/BotAvatar'
import { type AttachmentKind, attachmentKind } from '@/features/chat/lib/attachment-upload'
import { vmFolder } from '@/features/files/lib/files'
import { conversationName } from '@/features/knowledge/lib/knowledge'
import { useAppStore } from '@/features/workspace/store'
import { useBlobSrc } from '@/features/workspace/use-blob-src'
import { useWorkspaceId } from '@/features/workspace/use-workspace-id'
import { cn } from '@/lib/cn'
import { formatBytes, formatClock, formatListTime } from '@/lib/format'
import { MoreMenu } from '@/ui/MoreMenu'
import { Tooltip } from '@/ui/Tooltip'

import { fileErrorToast, openChatFile, revealChatFile, saveChatFile } from './store'

const KIND_ICONS: Record<AttachmentKind, LucideIcon> = {
  image: ImageIcon,
  pdf: FileText,
  text: FileText,
  archive: FileArchive,
  file: File,
}

/** Widths of the columns after the name, shared by the header and the rows. */
export const COL = {
  sender: 'w-[150px]',
  chat: 'w-[150px]',
  size: 'w-[72px]',
  when: 'w-[72px]',
  actions: 'w-[64px]',
}
export function FileRow({
  file,
  exactTime,
  last,
  onRename,
  onDelete,
}: {
  file: ChatFile
  exactTime: boolean
  last: boolean
  onRename: () => void
  onDelete: () => void
}) {
  const { t, i18n } = useTranslation()
  const workspaceId = useWorkspaceId()
  const showToast = useAppStore((s) => s.showToast)
  const openConversation = useAppStore((s) => s.openConversation)
  const bot = useAppStore((s) => (file.authorBotId ? s.bots[file.authorBotId] : undefined))
  const conversation = useAppStore((s) => s.conversations[file.conversationId])
  const bots = useAppStore((s) => s.bots)
  const where = conversationName(conversation, bots)
  const { attachment } = file
  const src = useBlobSrc(attachment.image?.sha256)
  const Icon = KIND_ICONS[attachmentKind(attachment.mimeType, attachment.name)]
  const ready = attachment.status === 'ready'

  const failed = (err: unknown) => showToast(fileErrorToast(err))
  const save = () =>
    void saveChatFile(workspaceId, attachment, t('chat.attachments.saveTitle'))
      .then((saved) => saved && showToast('fileSaved'))
      .catch(failed)
  const goToChat = () => void openConversation(file.conversationId).catch(() => showToast('error'))

  const tag =
    attachment.status === 'queued'
      ? { text: t('chat.attachments.waitingVm'), warn: true }
      : attachment.status === 'copying'
        ? { text: t('chat.attachments.copyingShort'), warn: false }
        : attachment.status === 'failed'
          ? { text: t('chat.attachments.failed'), warn: true }
          : null
  const ChatIcon = where?.type === 'group' ? Users : MessageCircle

  return (
    <div
      role="row"
      className={cn(
        'group flex items-center gap-4 px-4 py-[9px] hover:bg-surface-2',
        !last && 'border-b border-border',
      )}
    >
      <div role="cell" className="flex min-w-0 flex-1 items-center gap-3">
        {src ? (
          <img
            src={src}
            alt=""
            className="size-[34px] shrink-0 rounded-[7px] border border-border object-cover"
          />
        ) : (
          <span className="flex size-[34px] shrink-0 items-center justify-center rounded-[7px] bg-surface-3 text-fg-secondary">
            <Icon size={16} aria-hidden />
          </span>
        )}
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="flex min-w-0 items-center gap-2">
            <span className="truncate text-base font-semibold text-fg">{attachment.name}</span>
            {tag && (
              <span
                className={cn(
                  'shrink-0 rounded-[5px] px-1.5 py-px text-xs',
                  tag.warn ? 'bg-warning-tint text-warning' : 'bg-surface-3 text-fg-muted',
                )}
              >
                {tag.text}
              </span>
            )}
          </span>
          <span className="selectable truncate font-mono text-xs text-fg-muted">
            {vmFolder(attachment.path)}
          </span>
        </span>
      </div>
      <div role="cell" className={`flex ${COL.sender} min-w-0 items-center gap-[7px]`}>
        {bot ? (
          <BotAvatar avatar={bot.avatar} state={bot.status} size={18} className="shrink-0" />
        ) : (
          <span className="flex size-[18px] shrink-0 items-center justify-center rounded-full bg-surface-3 text-fg-secondary">
            <User size={11} aria-hidden />
          </span>
        )}
        <span className="truncate text-sm text-fg-secondary">
          {file.authorType === 'user' ? t('files.fromYou') : (bot?.name ?? t('files.fromBot'))}
        </span>
      </div>
      <div role="cell" className={`flex ${COL.chat} min-w-0 items-center gap-1.5`}>
        {where && (
          <>
            <ChatIcon size={13} className="shrink-0 text-fg-muted" aria-hidden />
            <span className="truncate text-sm text-fg-secondary">{where.name}</span>
          </>
        )}
      </div>
      <div role="cell" className={`${COL.size} text-right text-sm text-fg-muted tabular-nums`}>
        {formatBytes(attachment.size, i18n.language)}
      </div>
      <div role="cell" className={`${COL.when} text-right text-sm text-fg-muted tabular-nums`}>
        {exactTime
          ? formatClock(file.createdAt, i18n.language)
          : formatListTime(file.createdAt, i18n.language, t)}
      </div>
      <div role="cell" className={`flex ${COL.actions} items-center justify-end gap-1`}>
        {ready && (
          <Tooltip content={t('chat.attachments.save')}>
            <button
              type="button"
              onClick={save}
              aria-label={t('chat.attachments.saveNamed', { name: attachment.name })}
              className="focus-ring flex size-7 items-center justify-center rounded-[7px] border border-border bg-surface text-fg opacity-0 group-hover:opacity-100 hover:bg-surface-3 focus-visible:opacity-100"
            >
              <Download size={14} />
            </button>
          </Tooltip>
        )}
        <MoreMenu
          label={t('files.moreOptions', { name: attachment.name })}
          width={220}
          entries={[
            ...(ready
              ? [
                  {
                    key: 'save',
                    label: t('chat.attachments.save'),
                    icon: <Download size={14} />,
                    onSelect: save,
                  },
                  {
                    key: 'open',
                    label: t('files.open'),
                    icon: <SquareArrowOutUpRight size={14} />,
                    onSelect: () => void openChatFile(workspaceId, attachment.id).catch(failed),
                  },
                  {
                    key: 'reveal',
                    label: t('chat.attachments.reveal'),
                    icon: <FolderOpen size={14} />,
                    onSelect: () => void revealChatFile(workspaceId, attachment.id).catch(failed),
                  },
                ]
              : []),
            {
              key: 'chat',
              label: t('files.goToChat'),
              icon: <MessageSquare size={14} />,
              disabled: !where,
              onSelect: goToChat,
            },
            { type: 'separator' as const, key: 'sep' },
            {
              key: 'rename',
              label: t('files.rename.action'),
              icon: <Pencil size={14} />,
              disabled: !ready,
              onSelect: onRename,
            },
            {
              key: 'delete',
              label: t('files.delete.action'),
              icon: <Trash2 size={14} />,
              danger: true,
              disabled: attachment.status === 'copying',
              onSelect: onDelete,
            },
          ]}
        />
      </div>
    </div>
  )
}
