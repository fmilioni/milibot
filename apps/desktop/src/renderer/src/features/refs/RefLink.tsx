import type { RefKind } from '@milibot/shared'
import type { RefInfo } from '@milibot/shared'
import {
  BookOpen,
  Bot,
  FolderKanban,
  Frame,
  ListChecks,
  type LucideIcon,
  MessageSquare,
  PenTool,
  Repeat,
  Sparkles,
  SquareKanban,
  StickyNote,
  Terminal,
} from 'lucide-react'
import { createElement, type MouseEvent, type ReactNode } from 'react'

import { useRefInfo } from './use-ref'

const REF_ICONS: Record<RefKind, LucideIcon> = {
  card: StickyNote,
  board: SquareKanban,
  design: PenTool,
  frame: Frame,
  plan: ListChecks,
  session: Terminal,
  doc: BookOpen,
  project: FolderKanban,
  skill: Sparkles,
  routine: Repeat,
  conversation: MessageSquare,
  bot: Bot,
}

/**
 * An id written in text, shown with its item's current name and opening it on click. While loading, and
 * when the item no longer exists, the raw id stays as text. `onOpen` absent: the name without a link.
 */
export function RefLink({
  id,
  label,
  onOpen,
}: {
  id: string
  label?: ReactNode
  onOpen?: (info: RefInfo) => void
}) {
  const info = useRefInfo(id)
  if (!info) return label === undefined ? <span className="font-mono text-code">{id}</span> : <>{label}</>
  const body = (
    <>
      {createElement(REF_ICONS[info.kind], {
        size: 12,
        'aria-hidden': true,
        className: 'mr-0.5 inline-block shrink-0 align-[-1px]',
      })}
      {label ?? (info.name || id)}
    </>
  )
  if (!onOpen) return <span title={id}>{body}</span>
  // The page can't navigate: the click opens the item itself and never reaches a clickable parent.
  const open = (event: MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault()
    event.stopPropagation()
    onOpen(info)
  }
  return (
    <a
      href={id}
      title={id}
      data-ref={info.kind}
      onClick={open}
      className="focus-ring rounded-sm text-accent underline-offset-2 hover:underline"
    >
      {body}
    </a>
  )
}
