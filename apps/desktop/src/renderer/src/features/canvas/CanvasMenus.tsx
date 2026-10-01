import type { Bot, Design, DesignDetail, DesignFrame } from '@milibot/shared'
import type { TFunction } from 'i18next'
import { Code, Copy, Download, History, MessageSquare, PenTool, Scan, SwatchBook } from 'lucide-react'

import { shortcutLabel } from '@/lib/platform'
import type { MenuEntry } from '@/ui/Menu'

import { type DesignExport, FrameExportPanel } from './ExportPanel'

/** The right-click menu of a frame. */
export function frameMenuEntries({
  t,
  frame,
  design,
  bot,
  shownTheme,
  revisionCount,
  exporter,
  onAsk,
  onViewHtml,
  onTheme,
  onVersions,
  onCenter,
}: {
  t: TFunction
  frame: DesignFrame
  design: DesignDetail
  bot: Bot | undefined
  shownTheme: string
  revisionCount: number
  exporter: DesignExport
  /** "Ask for a change", only when there is a chat to write in. */
  onAsk: (() => void) | null
  onViewHtml: () => void
  onTheme: (theme: string) => void
  onVersions: () => void
  onCenter: () => void
}): MenuEntry[] {
  return [
    ...(onAsk
      ? ([
          {
            key: 'ask',
            label: bot ? t('canvas.menu.ask', { name: bot.name }) : t('canvas.menu.askGeneric'),
            icon: <MessageSquare size={14} />,
            onSelect: onAsk,
          },
          { type: 'separator', key: 's1' },
        ] satisfies MenuEntry[])
      : []),
    {
      key: 'export',
      label: t('canvas.export.title'),
      icon: <Download size={14} />,
      panel: (close) => <FrameExportPanel frame={frame} actions={exporter} onDone={close} />,
    },
    {
      key: 'copy',
      label: t('canvas.menu.copyImage'),
      icon: <Copy size={14} />,
      shortcut: shortcutLabel('C', true),
      onSelect: () => void exporter.copy(frame),
    },
    {
      key: 'html',
      label: t('canvas.menu.viewHtml'),
      icon: <Code size={14} />,
      onSelect: onViewHtml,
    },
    ...(design.themes.length > 1
      ? ([
          { type: 'separator', key: 's2' },
          ...design.themes.map((theme) => ({
            key: `theme:${theme}`,
            label: t('canvas.menu.theme', { name: theme }),
            icon: <SwatchBook size={14} />,
            checked: theme === shownTheme,
            onSelect: () => onTheme(theme),
          })),
        ] satisfies MenuEntry[])
      : []),
    { type: 'separator', key: 's3' },
    {
      key: 'versions',
      label: t('canvas.menu.versions'),
      icon: <History size={14} />,
      ...(revisionCount > 0 ? { shortcut: String(revisionCount) } : {}),
      onSelect: onVersions,
    },
    {
      key: 'center',
      label: t('canvas.menu.center'),
      icon: <Scan size={14} />,
      onSelect: onCenter,
    },
  ]
}

/** "Each frame's own" or one theme for every frame. */
export function themeMenuEntries(
  t: TFunction,
  themes: readonly string[],
  forced: string | null,
  onForce: (theme: string | null) => void,
): MenuEntry[] {
  return [
    { key: 'each', label: t('canvas.theme.each'), checked: forced === null, onSelect: () => onForce(null) },
    { type: 'separator', key: 's' },
    ...themes.map((theme, i) => ({
      key: theme,
      label: i === 0 ? t('canvas.theme.default', { name: theme }) : theme,
      icon: <SwatchBook size={14} />,
      checked: forced === theme,
      onSelect: () => onForce(theme),
    })),
  ]
}

/** The conversation's other designs, to switch the canvas to. */
export function switcherEntries(
  t: TFunction,
  ids: readonly string[],
  designs: Record<string, Design | undefined>,
  currentId: string,
  onSwitch: ((designId: string) => void) | undefined,
): MenuEntry[] {
  return ids.flatMap((id) => {
    const item = designs[id]
    if (item?.archivedAt != null && id !== currentId) return []
    return {
      key: id,
      label: item?.name ?? id,
      icon: <PenTool size={14} />,
      checked: id === currentId,
      shortcut: t('canvas.frames', { count: item?.frameCount ?? 0 }),
      onSelect: () => onSwitch?.(id),
    }
  })
}
