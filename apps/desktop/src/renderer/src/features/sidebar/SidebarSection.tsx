import { useDroppable } from '@dnd-kit/core'
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { ChevronDown, Pencil, Trash2 } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { useAppStore } from '@/features/workspace/store'
import { cn } from '@/lib/cn'
import { Menu } from '@/ui/Menu'

import { type SidebarGroup } from './sidebar-groups'
import { SidebarItem } from './SidebarItem'

export const SECTION_DROP_PREFIX = 'container:'

export function SidebarGroupView({
  group,
  bots,
  dragging,
}: {
  group: SidebarGroup
  bots: ReturnType<typeof useAppStore.getState>['bots']
  dragging: boolean
}) {
  const { t } = useTranslation()
  const updateSection = useAppStore((s) => s.updateSection)
  const { setNodeRef, isOver } = useDroppable({
    id: `${SECTION_DROP_PREFIX}${group.container}:${group.key}`,
    data: { container: group.container },
  })
  const collapsed = group.section?.collapsed ?? false
  const title =
    group.kind === 'section'
      ? (group.section?.name ?? '')
      : t(`sidebar.sections.${group.kind === 'pinned' ? 'pinned' : group.kind}`)

  return (
    <section
      ref={setNodeRef}
      aria-label={title}
      className={cn(
        'flex flex-col gap-0.5 rounded-xl transition-colors',
        dragging && isOver && 'bg-accent-soft',
      )}
    >
      <SectionHeader group={group} title={title}>
        {group.section && (
          <button
            type="button"
            aria-expanded={!collapsed}
            aria-label={collapsed ? t('sidebar.expandSection') : t('sidebar.collapseSection')}
            onClick={() => void updateSection(group.section!.id, { collapsed: !collapsed })}
            className="focus-ring rounded text-fg-muted opacity-0 group-hover/header:opacity-100 focus-visible:opacity-100"
          >
            <ChevronDown size={11} className={collapsed ? '-rotate-90' : ''} />
          </button>
        )}
      </SectionHeader>
      {!collapsed && (
        <SortableContext items={group.conversations.map((c) => c.id)} strategy={verticalListSortingStrategy}>
          {group.conversations.map((conversation) => (
            <SidebarItem
              key={conversation.id}
              conversation={conversation}
              bots={bots}
              containerKey={group.container}
            />
          ))}
        </SortableContext>
      )}
      {group.kind === 'section' && group.conversations.length === 0 && !collapsed && (
        <div className="mx-1 rounded-lg border border-dashed border-border px-2.5 py-2 text-xs text-fg-muted">
          {t('sidebar.emptySection')}
        </div>
      )}
    </section>
  )
}

function SectionHeader({
  group,
  title,
  children,
}: {
  group: SidebarGroup
  title: string
  children?: ReactNode
}) {
  const { t } = useTranslation()
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const [renaming, setRenaming] = useState(false)
  const store = useAppStore.getState
  const section = group.section

  return (
    <div
      className="group/header flex h-4 items-center gap-1 px-2.5 pb-1"
      onContextMenu={(e) => {
        if (!section) return
        e.preventDefault()
        setMenu({ x: e.clientX, y: e.clientY })
      }}
    >
      {renaming && section ? (
        <input
          autoFocus
          defaultValue={section.name}
          maxLength={40}
          aria-label={t('sidebar.renameSection')}
          onBlur={(e) => {
            const name = e.target.value.trim()
            if (name && name !== section.name) void store().updateSection(section.id, { name })
            setRenaming(false)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur()
            if (e.key === 'Escape') setRenaming(false)
          }}
          className="selectable h-4 min-w-0 flex-1 rounded border border-accent bg-surface-2 px-1 text-2xs font-semibold tracking-[0.08em] uppercase outline-none"
        />
      ) : (
        <h3
          className="truncate text-2xs leading-3 font-semibold tracking-[0.08em] text-fg-muted uppercase"
          onDoubleClick={() => section && setRenaming(true)}
        >
          {title}
        </h3>
      )}
      {children}
      {menu && section && (
        <Menu
          x={menu.x}
          y={menu.y}
          width={190}
          onClose={() => setMenu(null)}
          label={title}
          entries={[
            {
              key: 'rename',
              label: t('sidebar.renameSection'),
              icon: <Pencil size={14} />,
              onSelect: () => setRenaming(true),
            },
            {
              key: 'delete',
              label: t('sidebar.deleteSection'),
              icon: <Trash2 size={14} />,
              danger: true,
              onSelect: () => void store().deleteSection(section.id),
            },
          ]}
        />
      )}
    </div>
  )
}
