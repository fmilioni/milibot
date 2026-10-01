import type { DesignDetail, DesignFrame, DesignPayload } from '@milibot/shared'
import { Archive, ArchiveRestore, Eye, Palette, Pencil, Trash2 } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { FramePage } from '@/features/canvas/FramePage'
import { frameHeight, resolveTheme, themeBackground, themeKey } from '@/features/canvas/lib/canvas'
import { useDesignStore } from '@/features/canvas/store'
import { screenIs, useAppStore } from '@/features/workspace/store'
import { cn } from '@/lib/cn'
import { Button } from '@/ui/Button'
import { MoreMenu } from '@/ui/MoreMenu'

import { DeleteDesignDialog } from './DeleteDesignDialog'
import { RenameDesignDialog } from './RenameDesignDialog'

const STRIP_HEIGHT = 120
const MINI_HEIGHT = 92
const MINI_GAP = 10
const MAX_MINIS = 4

/** "Design · <name>" in the chat: the first frames in miniature, "Open" or "Opened". */
export function DesignCard({ payload, conversationId }: { payload: DesignPayload; conversationId: string }) {
  const { t } = useTranslation()
  const workspaceId = useAppStore((s) => s.workspaceId)
  const open = useAppStore((s) => screenIs(s.screen, 'canvas')?.designId === payload.designId)
  const openCanvas = useAppStore((s) => s.openCanvas)
  const showToast = useAppStore((s) => s.showToast)
  const design = useDesignStore((s) => s.details[payload.designId])
  const load = useDesignStore((s) => s.load)
  const archiveDesign = useDesignStore((s) => s.archiveDesign)
  const [deleting, setDeleting] = useState(false)
  const [renaming, setRenaming] = useState(false)

  useEffect(() => {
    if (!payload.removed && workspaceId && !design)
      void load(workspaceId, payload.designId).catch(() => undefined)
  }, [payload.removed, payload.designId, workspaceId, design, load])

  const show = () => void openCanvas(payload.designId, conversationId).catch(() => showToast('error'))
  const frameCount = design?.frames.length ?? payload.frameCount
  const archived = design ? design.archivedAt !== null : payload.archived === true
  const setArchived = (value: boolean) => {
    if (workspaceId) void archiveDesign(workspaceId, payload.designId, value).catch(() => showToast('error'))
  }

  if (payload.removed) {
    return (
      <div className="flex w-[310px] max-w-full items-center gap-2.5 rounded-xl border border-border bg-surface-2 px-3 py-2.5">
        <Palette size={14} className="shrink-0 text-fg-muted" />
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="truncate text-base font-semibold text-fg-secondary line-through">
            {payload.name}
          </span>
          <span className="text-xs text-fg-muted">{t('chat.design.removed')}</span>
        </div>
      </div>
    )
  }

  return (
    <div
      className={cn(
        'flex w-[310px] max-w-full flex-col overflow-hidden rounded-xl border bg-surface-2',
        open ? 'border-accent' : 'border-border',
      )}
    >
      <button
        type="button"
        onClick={show}
        aria-label={t('canvas.openDesign', { name: payload.name })}
        className={cn(
          'focus-inset relative block w-full overflow-hidden bg-surface-3',
          archived && 'opacity-60',
        )}
        style={{ height: STRIP_HEIGHT }}
      >
        {design && workspaceId ? <Strip workspaceId={workspaceId} design={design} /> : null}
      </button>
      <div className="flex items-center gap-2.5 px-3 py-2.5">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate text-base font-semibold text-fg">{design?.name ?? payload.name}</span>
          <span className="truncate text-xs text-fg-secondary">
            {t(open ? 'canvas.card.subOpen' : 'canvas.card.sub', {
              frames: t('canvas.frames', { count: frameCount }),
            })}
          </span>
        </div>
        {archived && !open ? (
          <span className="flex shrink-0 items-center gap-1 rounded-md bg-surface-3 px-2 py-[3px] text-xs font-semibold text-fg-secondary">
            <Archive size={11} aria-hidden />
            {t('canvas.archive.archived')}
          </span>
        ) : open ? (
          <span className="flex shrink-0 items-center gap-1 rounded-md bg-accent-soft px-2 py-[3px] text-xs font-semibold text-accent">
            <Eye size={11} aria-hidden />
            {t('canvas.opened')}
          </span>
        ) : (
          <Button variant="secondary" size="sm" onClick={show}>
            {t('canvas.open')}
          </Button>
        )}
        <MoreMenu
          label={t('canvas.moreOptions', { name: design?.name ?? payload.name })}
          width={180}
          entries={[
            {
              key: 'rename',
              label: t('canvas.rename.action'),
              icon: <Pencil size={14} />,
              onSelect: () => setRenaming(true),
            },
            archived
              ? {
                  key: 'unarchive',
                  label: t('canvas.archive.unarchive'),
                  icon: <ArchiveRestore size={14} />,
                  onSelect: () => setArchived(false),
                }
              : {
                  key: 'archive',
                  label: t('canvas.archive.action'),
                  icon: <Archive size={14} />,
                  onSelect: () => setArchived(true),
                },
            { type: 'separator', key: 'sep' },
            {
              key: 'delete',
              label: t('canvas.delete.action'),
              icon: <Trash2 size={14} />,
              danger: true,
              onSelect: () => setDeleting(true),
            },
          ]}
        />
      </div>
      {renaming && workspaceId && (
        <RenameDesignDialog
          workspaceId={workspaceId}
          designId={payload.designId}
          name={design?.name ?? payload.name}
          onClose={() => setRenaming(false)}
        />
      )}
      {deleting && workspaceId && (
        <DeleteDesignDialog
          workspaceId={workspaceId}
          designId={payload.designId}
          name={design?.name ?? payload.name}
          onClose={() => setDeleting(false)}
        />
      )}
    </div>
  )
}

/** The first frames side by side at the same height, centered (their real pages, scaled down). */
function Strip({ workspaceId, design }: { workspaceId: string; design: DesignDetail }) {
  const measured = useDesignStore((s) => s.measured)
  const frames = design.frames.slice(0, MAX_MINIS)
  const keys = useMemo(() => {
    const out: Record<string, string> = {}
    for (const theme of design.themes) out[theme] = themeKey(design, theme)
    return out
  }, [design])
  const sized = frames.map((frame) => {
    const height = Math.min(frameHeight(frame, measured[frame.id]), frame.width * 2)
    const scale = MINI_HEIGHT / height
    return { frame, height, scale, width: Math.round(frame.width * scale) }
  })
  const total = sized.reduce((sum, s) => sum + s.width, 0) + MINI_GAP * Math.max(0, sized.length - 1)
  return (
    <div
      className="absolute flex"
      style={{ top: (STRIP_HEIGHT - MINI_HEIGHT) / 2, left: `calc(50% - ${total / 2}px)`, gap: MINI_GAP }}
      aria-hidden
    >
      {sized.map(({ frame, height, scale, width }) => (
        <Mini
          key={frame.id}
          workspaceId={workspaceId}
          design={design}
          frame={frame}
          height={height}
          scale={scale}
          width={width}
          version={keys}
        />
      ))}
    </div>
  )
}

function Mini({
  workspaceId,
  design,
  frame,
  height,
  scale,
  width,
  version,
}: {
  workspaceId: string
  design: DesignDetail
  frame: DesignFrame
  height: number
  scale: number
  width: number
  version: Record<string, string>
}) {
  const theme = resolveTheme(design.themes, frame.theme)
  const background = themeBackground(design, theme)
  return (
    <div
      className="relative shrink-0 overflow-hidden rounded-[3px] shadow-[0_0_0_1px_rgba(0,0,0,0.08)]"
      style={{ width, height: MINI_HEIGHT, background: background ?? 'var(--surface-2)' }}
    >
      <div
        className="absolute top-0 left-0 origin-top-left"
        style={{ width: frame.width, height, transform: `scale(${scale})` }}
      >
        <FramePage
          workspaceId={workspaceId}
          designId={design.id}
          frame={frame}
          theme={theme}
          version={`${frame.updatedAt}:${version[theme] ?? ''}`}
          height={height}
          background={background}
        />
      </div>
    </div>
  )
}
