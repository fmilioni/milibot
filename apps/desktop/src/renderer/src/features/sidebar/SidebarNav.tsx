import { FolderOpen, type LucideIcon, PenTool, SquareKanban } from 'lucide-react'
import { type ReactNode, useEffect } from 'react'
import { useTranslation } from 'react-i18next'

import { boardsIn } from '@/features/boards/lib/boards'
import { useBoardStore } from '@/features/boards/store'
import { type NavScreen, useAppStore } from '@/features/workspace/store'
import { cn } from '@/lib/cn'

/** Rows at the top of the sidebar: boards, designs and files, each opening its screen instead of the chat. */
export function SidebarNav() {
  const { t } = useTranslation()
  const openDesigns = useAppStore((s) => s.openDesigns)
  const openFiles = useAppStore((s) => s.openFiles)
  return (
    <nav aria-label={t('sidebar.nav')} className="flex flex-col gap-0.5">
      <BoardsRow />
      <NavRow kind="designs" icon={PenTool} label={t('designs.nav')} onClick={openDesigns} />
      <NavRow kind="files" icon={FolderOpen} label={t('files.nav')} onClick={openFiles} />
    </nav>
  )
}

/** "Boards", with how many are in progress. */
function BoardsRow() {
  const { t } = useTranslation()
  const workspaceId = useAppStore((s) => s.workspaceId)
  const openBoards = useAppStore((s) => s.openBoards)
  const loaded = useBoardStore((s) => s.workspaceId === workspaceId && s.loaded)
  const active = useBoardStore((s) =>
    s.workspaceId === workspaceId ? boardsIn(s.boards, 'active').length : 0,
  )
  const load = useBoardStore((s) => s.load)

  useEffect(() => {
    if (workspaceId && !loaded) void load(workspaceId).catch(() => undefined)
  }, [workspaceId, loaded, load])

  return (
    <NavRow
      kind="boards"
      icon={SquareKanban}
      label={t('boards.nav')}
      onClick={() => openBoards()}
      badge={
        active > 0 && (
          <span className="rounded-md bg-accent-soft px-1.5 text-xs font-semibold text-accent">{active}</span>
        )
      }
    />
  )
}

function NavRow({
  kind,
  icon: Icon,
  label,
  onClick,
  badge,
}: {
  kind: NavScreen['kind']
  icon: LucideIcon
  label: string
  onClick: () => void
  badge?: ReactNode
}) {
  const open = useAppStore((s) => s.screen.kind === kind)
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={open ? 'page' : undefined}
      className={cn(
        'no-drag focus-ring flex h-[30px] items-center gap-2 rounded-lg px-2.5 text-base',
        open ? 'bg-surface-3 font-semibold text-fg' : 'text-fg-secondary hover:bg-surface-2 hover:text-fg',
      )}
    >
      <Icon size={15} className={open ? 'text-accent' : ''} aria-hidden />
      <span className="flex-1 text-left">{label}</span>
      {badge}
    </button>
  )
}
