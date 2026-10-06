import type { Bot, DesignDetail } from '@milibot/shared'
import {
  AppWindow,
  Archive,
  ArchiveRestore,
  ChevronDown,
  Download,
  MessageSquare,
  Palette,
  PenTool,
  SwatchBook,
  Trash2,
  X,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { useNow } from '@/hooks/use-now'
import { cn } from '@/lib/cn'
import { formatRelative } from '@/lib/format'
import { MoreMenu } from '@/ui/MoreMenu'
import { Spinner } from '@/ui/Spinner'
import { Tooltip } from '@/ui/Tooltip'

const toolbarButton = (active: boolean) =>
  `no-drag focus-ring flex h-[27px] items-center gap-1.5 rounded-lg border px-2.5 text-sm ${
    active ? 'border-accent bg-surface-3' : 'border-border bg-surface-2 hover:bg-surface-3'
  }`

/** The canvas header: the design (switcher), theme, variables, export, open in a window and close. */
export function CanvasToolbar({
  workspaceId,
  design,
  bot,
  windowMode,
  canSwitch,
  forcedTheme,
  variablesOpen,
  exportOpen,
  exporting,
  commentTool,
  canComment,
  onCommentTool,
  onSwitcher,
  onThemeMenu,
  onVariables,
  onExport,
  onArchive,
  onDelete,
  onClose,
}: {
  workspaceId: string
  design: DesignDetail
  bot: Bot | undefined
  windowMode: boolean
  /** More than one design of the conversation to switch to. */
  canSwitch: boolean
  forcedTheme: string | null
  variablesOpen: boolean
  exportOpen: boolean
  exporting: boolean
  commentTool: boolean
  /** There is a conversation to send comments to. */
  canComment: boolean
  onCommentTool: () => void
  onSwitcher: (anchor: DOMRect) => void
  onThemeMenu: (anchor: DOMRect) => void
  onVariables: () => void
  onExport: (anchor: DOMRect) => void
  onArchive: (archived: boolean) => void
  onDelete: () => void
  onClose: () => void
}) {
  const { t, i18n } = useTranslation()
  const now = useNow(30_000)
  const edited = formatRelative(design.updatedAt, i18n.language, now, t('time.now'))
  const closeLabel = windowMode ? t('common.close') : t('canvas.close')
  return (
    <header
      className={cn(
        'drag-region flex h-14 shrink-0 items-center gap-2.5 border-b border-border bg-bg pr-3.5 win:pr-caption-3.5',
        windowMode ? 'pl-3.5 mac:pl-[84px]' : 'pl-3.5',
      )}
    >
      <span className="flex size-7 shrink-0 items-center justify-center rounded-[7px] bg-accent-soft text-accent">
        <PenTool size={14} aria-hidden />
      </span>
      <div className="flex min-w-0 flex-col">
        <button
          type="button"
          data-menu
          disabled={!canSwitch}
          onClick={(e) => onSwitcher(e.currentTarget.getBoundingClientRect())}
          aria-haspopup="menu"
          aria-label={t('canvas.switchDesign', { name: design.name })}
          className="no-drag focus-ring flex min-w-0 items-center gap-1 rounded text-left disabled:cursor-default"
        >
          <span className="truncate text-base leading-4 font-semibold text-fg">{design.name}</span>
          {canSwitch && <ChevronDown size={12} className="shrink-0 text-fg-muted" />}
        </button>
        <span className="truncate text-xs leading-[13px] text-fg-muted">
          {t('canvas.meta', {
            frames: t('canvas.frames', { count: design.frames.length }),
            author: bot?.name ?? t('canvas.revisions.you'),
            when: edited,
          })}
        </span>
      </div>
      <div className="flex-1" />
      <Tooltip
        content={
          canComment
            ? t('canvas.comment.toolHint', { name: bot?.name ?? '…' })
            : t('canvas.comment.toolUnavailable')
        }
      >
        <button
          type="button"
          aria-pressed={commentTool}
          aria-keyshortcuts="C"
          aria-disabled={!canComment}
          onClick={canComment ? onCommentTool : undefined}
          className={cn(toolbarButton(commentTool), 'aria-disabled:cursor-default aria-disabled:opacity-50')}
        >
          <MessageSquare
            size={13}
            className={commentTool ? 'text-accent' : 'text-fg-secondary'}
            aria-hidden
          />
          <span className="font-semibold text-fg">{t('canvas.comment.tool')}</span>
        </button>
      </Tooltip>
      {design.themes.length > 1 && (
        <button
          type="button"
          data-menu
          aria-haspopup="menu"
          onClick={(e) => onThemeMenu(e.currentTarget.getBoundingClientRect())}
          className={toolbarButton(false)}
        >
          <SwatchBook size={13} className="text-fg-secondary" aria-hidden />
          <span className="text-fg-secondary">{t('canvas.theme.label')}</span>
          <span className="max-w-[140px] truncate font-semibold text-fg">
            {forcedTheme ?? t('canvas.theme.each')}
          </span>
          <ChevronDown size={12} className="text-fg-muted" aria-hidden />
        </button>
      )}
      <button
        type="button"
        aria-expanded={variablesOpen}
        onClick={onVariables}
        className={toolbarButton(variablesOpen)}
      >
        <Palette size={13} className="text-fg-secondary" aria-hidden />
        <span className="font-semibold text-fg">{t('canvas.variables.title')}</span>
      </button>
      <button
        type="button"
        data-menu
        aria-haspopup="menu"
        aria-expanded={exportOpen}
        onClick={(e) => onExport(e.currentTarget.getBoundingClientRect())}
        className={toolbarButton(exportOpen)}
      >
        {exporting ? (
          <Spinner size={13} className="text-fg-secondary" />
        ) : (
          <Download size={13} className="text-fg-secondary" aria-hidden />
        )}
        <span className="font-semibold text-fg">{t('canvas.export.title')}</span>
      </button>
      <span className="no-drag">
        <MoreMenu
          label={t('canvas.moreOptions', { name: design.name })}
          width={180}
          entries={[
            design.archivedAt === null
              ? {
                  key: 'archive',
                  label: t('canvas.archive.action'),
                  icon: <Archive size={14} />,
                  onSelect: () => onArchive(true),
                }
              : {
                  key: 'unarchive',
                  label: t('canvas.archive.unarchive'),
                  icon: <ArchiveRestore size={14} />,
                  onSelect: () => onArchive(false),
                },
            { type: 'separator', key: 'sep' },
            {
              key: 'delete',
              label: t('canvas.delete.action'),
              icon: <Trash2 size={14} />,
              danger: true,
              onSelect: onDelete,
            },
          ]}
        />
      </span>
      <span className="mx-1 h-5 w-px bg-border" aria-hidden />
      {!windowMode && (
        <Tooltip content={t('canvas.openWindow')}>
          <button
            type="button"
            aria-label={t('canvas.openWindow')}
            onClick={() =>
              void window.milibot.openCanvasWindow({ workspaceId, designId: design.id, title: design.name })
            }
            className="no-drag focus-ring flex size-7 items-center justify-center rounded-md text-fg-secondary hover:bg-surface-3"
          >
            <AppWindow size={16} />
          </button>
        </Tooltip>
      )}
      <Tooltip content={closeLabel}>
        <button
          type="button"
          aria-label={closeLabel}
          onClick={onClose}
          className="no-drag focus-ring flex size-7 items-center justify-center rounded-md text-fg-secondary hover:bg-surface-3"
        >
          <X size={16} />
        </button>
      </Tooltip>
    </header>
  )
}
