import {
  closestCenter,
  type CollisionDetection,
  DndContext,
  type DragEndEvent,
  DragOverlay,
  type DragStartEvent,
  PointerSensor,
  pointerWithin,
  useSensor,
  useSensors,
} from '@dnd-kit/core'
import {
  type ConversationSummary,
  itemsIn,
  PINNED_CONTAINER,
  slotFromContainer,
  UNSECTIONED_CONTAINER,
} from '@milibot/shared'
import { GripVertical, Search } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { BotAvatar } from '@/features/bots/avatar/BotAvatar'
import { GroupAvatar } from '@/features/bots/avatar/GroupAvatar'
import { describeConversation, matchesSearch } from '@/features/chat/lib/conversation'
import { useAppStore } from '@/features/workspace/store'

import { NewMenu } from './NewMenu'
import { groupSidebar, sidebarOrderItems } from './sidebar-groups'
import { SidebarFooter } from './SidebarFooter'
import { SidebarNav } from './SidebarNav'
import { SECTION_DROP_PREFIX, SidebarGroupView } from './SidebarSection'
import { SystemUpdateCard } from './SystemUpdateCard'
import { WorkspaceSwitcher } from './WorkspaceSwitcher'

/** Prefer the list under the pointer (so empty sections accept drops), then the closest row. */
const collision: CollisionDetection = (args) => {
  const within = pointerWithin(args)
  const item = within.find((c) => !String(c.id).startsWith(SECTION_DROP_PREFIX))
  if (item) return [item]
  if (within.length > 0) return within
  return closestCenter(args)
}

export function Sidebar() {
  const { t } = useTranslation()
  const conversations = useAppStore((s) => s.conversations)
  const bots = useAppStore((s) => s.bots)
  const allBots = Object.values(bots)
  const soleBot = allBots.length === 1 ? allBots[0] : undefined
  const sections = useAppStore((s) => s.sections)
  const search = useAppStore((s) => s.search)
  const setSearch = useAppStore((s) => s.setSearch)
  const moveConversation = useAppStore((s) => s.moveConversation)
  const [dragging, setDragging] = useState<string | null>(null)

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }))
  const searching = search.trim().length > 0

  const groups = useMemo(() => {
    const all = Object.values(conversations)
    const filtered = searching
      ? all.filter((c) => matchesSearch(describeConversation(c, bots, t('sidebar.groupFallback')), search))
      : all
    return groupSidebar(filtered, sections, { includeHidden: searching, keepEmptySections: !searching })
  }, [conversations, bots, sections, search, searching, t])

  const onDragStart = (event: DragStartEvent) => setDragging(String(event.active.id))

  const onDragEnd = (event: DragEndEvent) => {
    setDragging(null)
    const { active, over } = event
    if (!over) return
    const activeId = String(active.id)
    const overId = String(over.id)
    const moving = conversations[activeId]
    if (!moving) return
    const items = sidebarOrderItems(conversations)
    let container: string
    let index: number | undefined
    if (overId.startsWith(SECTION_DROP_PREFIX)) {
      container = String(over.data.current?.container ?? UNSECTIONED_CONTAINER)
    } else {
      const target = conversations[overId]
      if (!target || overId === activeId) return
      container = target.sidebar.pinned
        ? PINNED_CONTAINER
        : (target.sidebar.sectionId ?? UNSECTIONED_CONTAINER)
      index = itemsIn(items, container).findIndex((i) => i.id === overId)
    }
    const slot = slotFromContainer(container, moving.sidebar.sectionId)
    void moveConversation(activeId, slot, index)
  }

  const draggingConversation = dragging ? conversations[dragging] : undefined

  return (
    <aside
      aria-label={t('sidebar.label')}
      className="flex w-[var(--sidebar-width)] shrink-0 flex-col border-r border-border bg-surface"
    >
      <div className="drag-region flex flex-col gap-4 px-3 pt-3 mac:pt-9">
        <div className="flex items-center justify-between px-1">
          <WorkspaceSwitcher />
          <NewMenu />
        </div>
        <label className="no-drag flex h-8 items-center gap-2 rounded-lg bg-surface-2 px-2.5 focus-within:ring-1 focus-within:ring-accent/50">
          <Search size={14} className="shrink-0 text-fg-muted" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => e.key === 'Escape' && setSearch('')}
            placeholder={t('sidebar.search')}
            aria-label={t('sidebar.search')}
            className="min-w-0 flex-1 bg-transparent text-base outline-none placeholder:text-fg-muted"
          />
        </label>
        <SidebarNav />
      </div>

      <DndContext
        sensors={sensors}
        collisionDetection={collision}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        onDragCancel={() => setDragging(null)}
      >
        <nav className="scroll-slim mt-4 flex min-h-0 flex-1 flex-col gap-3.5 overflow-y-auto px-3 pb-3">
          {groups.map((group) => (
            <SidebarGroupView key={group.key} group={group} bots={bots} dragging={dragging !== null} />
          ))}
          {groups.every((g) => g.conversations.length === 0) && searching && (
            <div className="px-2.5 py-4 text-center text-sm leading-4 text-fg-muted">
              {t('sidebar.noResults')}
            </div>
          )}
          {!searching && soleBot && (
            <div className="flex flex-col gap-1.5 px-2.5 pt-3">
              <span className="text-sm font-semibold text-fg-secondary">{t('setup.team.title')}</span>
              <span className="text-sm leading-[1.5] text-fg-muted">
                {t('setup.team.hint', { name: soleBot.name })}
              </span>
            </div>
          )}
        </nav>
        {dragging && (
          <div className="mx-3 mb-2 flex items-center gap-2 rounded-lg bg-accent-soft px-2.5 py-2 text-xs leading-[13px] text-accent">
            <GripVertical size={14} className="shrink-0" />
            {t('sidebar.dragHint')}
          </div>
        )}
        <DragOverlay dropAnimation={null}>
          {draggingConversation && <DragPreview conversation={draggingConversation} />}
        </DragOverlay>
      </DndContext>

      <SystemUpdateCard />
      <SidebarFooter />
    </aside>
  )
}

function DragPreview({ conversation }: { conversation: ConversationSummary }) {
  const { t } = useTranslation()
  const bots = useAppStore((s) => s.bots)
  const display = describeConversation(conversation, bots, t('sidebar.groupFallback'))
  return (
    <div className="flex h-[52px] w-[256px] items-center gap-2.5 rounded-[10px] border border-border bg-surface-2 px-2.5 shadow-lg">
      {display.primaryBot ? (
        <BotAvatar
          avatar={display.primaryBot.avatar}
          state={display.primaryBot.status}
          size={36}
          animated={false}
        />
      ) : (
        <GroupAvatar
          members={display.members.map((m) => ({ id: m.id, avatar: m.avatar }))}
          size={36}
          animated={false}
        />
      )}
      <span className="truncate text-base font-semibold text-fg">{display.title}</span>
    </div>
  )
}
