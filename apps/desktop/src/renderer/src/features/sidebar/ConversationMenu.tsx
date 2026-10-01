import type { ConversationSummary } from '@milibot/shared'
import {
  BellDot,
  Check,
  Copy,
  EyeOff,
  Folder,
  FolderInput,
  FolderPlus,
  FolderX,
  Palette,
  Pencil,
  Pin,
  PinOff,
  Trash2,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { useAppStore } from '@/features/workspace/store'
import { Menu, type MenuEntry } from '@/ui/Menu'

export function ConversationMenu({
  conversation,
  x,
  y,
  onClose,
}: {
  conversation: ConversationSummary
  x: number
  y: number
  onClose: () => void
}) {
  const { t } = useTranslation()
  const sections = useAppStore((s) => s.sections)
  const store = useAppStore.getState
  const { pinned, sectionId } = conversation.sidebar
  const iconSize = 14

  const moveTo: MenuEntry[] = [
    {
      key: 'pinned',
      label: t('sidebar.sections.pinned'),
      icon: pinned ? <Check size={iconSize} className="text-accent" /> : <Folder size={iconSize} />,
      onSelect: () => void store().setPinned(conversation.id, true),
    },
    ...[...sections]
      .sort((a, b) => a.order - b.order)
      .map<MenuEntry>((section) => ({
        key: section.id,
        label: section.name,
        icon:
          !pinned && sectionId === section.id ? (
            <Check size={iconSize} className="text-accent" />
          ) : (
            <Folder size={iconSize} />
          ),
        onSelect: () =>
          void store().moveConversation(conversation.id, { pinned: false, sectionId: section.id }),
      })),
    {
      key: 'none',
      label: t('sidebar.sections.none'),
      icon:
        !pinned && !sectionId ? (
          <Check size={iconSize} className="text-accent" />
        ) : (
          <FolderX size={iconSize} />
        ),
      onSelect: () => void store().moveConversation(conversation.id, { pinned: false, sectionId: null }),
    },
    { type: 'separator', key: 'sep' },
    {
      key: 'create',
      label: t('sidebar.menu.createSection'),
      icon: <FolderPlus size={iconSize} />,
      onSelect: () => store().setModal({ type: 'newSection', moveConversationId: conversation.id }),
    },
  ]

  const entries: MenuEntry[] = [
    {
      key: 'pin',
      label: pinned ? t('sidebar.menu.unpin') : t('sidebar.menu.pin'),
      icon: pinned ? <PinOff size={iconSize} /> : <Pin size={iconSize} />,
      onSelect: () => void store().setPinned(conversation.id, !pinned),
    },
    { key: 'move', label: t('sidebar.menu.moveTo'), icon: <FolderInput size={iconSize} />, submenu: moveTo },
    { type: 'separator', key: 's1' },
    {
      key: 'unread',
      label: t('sidebar.menu.markUnread'),
      icon: <BellDot size={iconSize} />,
      disabled: conversation.sidebar.unreadCount > 0,
      onSelect: () => void store().markUnread(conversation.id),
    },
    ...(conversation.type === 'direct'
      ? [
          {
            key: 'avatar',
            label: t('sidebar.menu.customizeAvatar'),
            icon: <Palette size={iconSize} />,
            onSelect: () => {
              store().selectConversation(conversation.id)
              store().openRightPanel('bot')
            },
          },
        ]
      : []),
    {
      key: 'rename',
      label: t('sidebar.menu.rename'),
      icon: <Pencil size={iconSize} />,
      shortcut: 'F2',
      onSelect: () => store().setRenaming(conversation.id),
    },
    {
      key: 'copy',
      label: t('sidebar.menu.copyId'),
      icon: <Copy size={iconSize} />,
      onSelect: () => {
        void navigator.clipboard.writeText(conversation.id).then(() => store().showToast('copied'))
      },
    },
    { type: 'separator', key: 's2' },
    {
      key: 'hide',
      label: t('sidebar.menu.hide'),
      icon: <EyeOff size={iconSize} />,
      onSelect: () => void store().setHidden(conversation.id, true),
    },
    {
      key: 'delete',
      label: t('sidebar.menu.delete'),
      icon: <Trash2 size={iconSize} />,
      danger: true,
      onSelect: () => store().setModal({ type: 'confirmDelete', conversationId: conversation.id }),
    },
  ]

  return <Menu entries={entries} x={x} y={y} onClose={onClose} label={t('sidebar.menu.label')} />
}
