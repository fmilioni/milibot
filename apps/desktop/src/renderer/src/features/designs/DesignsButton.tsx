import type { ConversationSummary } from '@milibot/shared'
import { Archive, PenTool } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { useDesignStore } from '@/features/canvas/store'
import { useAppStore } from '@/features/workspace/store'
import { IconButton } from '@/ui/IconButton'
import { Menu, type MenuEntry } from '@/ui/Menu'

const NO_DESIGNS: string[] = []

/** "Designs" in the conversation header: the designs of this chat (and of its bot, in a DM). */
export function DesignsButton({ conversation }: { conversation: ConversationSummary }) {
  const { t } = useTranslation()
  const workspaceId = useAppStore((s) => s.workspaceId)
  const openCanvas = useAppStore((s) => s.openCanvas)
  const showToast = useAppStore((s) => s.showToast)
  const ids = useDesignStore((s) => s.byConversation[conversation.id]) ?? NO_DESIGNS
  const designs = useDesignStore((s) => s.designs)
  const loadForConversation = useDesignStore((s) => s.loadForConversation)
  const [menu, setMenu] = useState<DOMRect | null>(null)
  const [showArchived, setShowArchived] = useState(false)
  const botId = conversation.type === 'direct' ? conversation.memberBotIds[0] : undefined

  useEffect(() => {
    if (workspaceId) void loadForConversation(workspaceId, conversation.id, botId).catch(() => undefined)
  }, [workspaceId, conversation.id, botId, loadForConversation])

  const all = ids.flatMap((id) => designs[id] ?? [])
  const active = all.filter((d) => d.archivedAt === null)
  const archived = all.filter((d) => d.archivedAt !== null)
  if (all.length === 0) return null
  const entry = (design: (typeof all)[number]): MenuEntry => ({
    key: design.id,
    label: design.name,
    icon: design.archivedAt === null ? <PenTool size={14} /> : <Archive size={14} />,
    shortcut:
      design.archivedAt === null
        ? t('canvas.frames', { count: design.frameCount })
        : t('canvas.archive.archived'),
    onSelect: () =>
      void openCanvas(design.id, design.conversationId ?? conversation.id).catch(() => showToast('error')),
  })
  const entries: MenuEntry[] = [
    ...active.map(entry),
    ...(showArchived && archived.length
      ? [{ type: 'separator' as const, key: 'sep-archived' }, ...archived.map(entry)]
      : []),
    ...(archived.length
      ? [
          ...(active.length ? [{ type: 'separator' as const, key: 'sep-toggle' }] : []),
          {
            key: 'show-archived',
            label: t('canvas.archive.show', { count: archived.length }),
            icon: <Archive size={14} />,
            checked: showArchived,
            onSelect: () => setShowArchived(!showArchived),
          },
        ]
      : []),
  ]
  return (
    <>
      <IconButton
        label={t('canvas.designs')}
        data-menu
        aria-haspopup="menu"
        active={menu !== null}
        onClick={(e) => setMenu(menu ? null : e.currentTarget.getBoundingClientRect())}
      >
        <PenTool size={15} />
      </IconButton>
      {menu && (
        <Menu
          label={t('canvas.designsTitle')}
          x={menu.right - 280}
          y={menu.bottom + 6}
          width={280}
          onClose={() => setMenu(null)}
          entries={entries}
        />
      )}
    </>
  )
}
