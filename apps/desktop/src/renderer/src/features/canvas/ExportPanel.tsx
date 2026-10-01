import type { DesignDetail, DesignFrame } from '@milibot/shared'
import { FileCode, Files, FileText, Image as ImageIcon, Package } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { exportDesign, getDesignFrameHtml, getDesignFrameSource } from '@/features/canvas/api'
import { type ToastKey, useAppStore } from '@/features/workspace/store'
import { useApiMutation } from '@/features/workspace/use-api-mutation'
import { readPref, writePref } from '@/lib/prefs'
import { Segmented } from '@/ui/Segmented'

import type { DesignExportFrame } from '../../../../bridge/contract'

const SCALE_KEY = 'milibot.canvas.pngScale'
const SCALES = ['1', '2', '3'] as const
type Scale = (typeof SCALES)[number]

function readScale(): Scale {
  const value = readPref(SCALE_KEY)
  return SCALES.find((s) => s === value) ?? '2'
}

/** Exports of a design's frames, rendered by the main process from the same pages the canvas shows. */
export function useDesignExport(
  workspaceId: string,
  design: DesignDetail,
  themeOf: (frame: DesignFrame) => string,
) {
  const { t } = useTranslation()
  const showToast = useAppStore((s) => s.showToast)
  const exporter = useApiMutation(
    ({ action }: { action: () => Promise<boolean>; done: ToastKey }) => action(),
    { errorToast: 'designExportFailed', onSuccess: (saved, { done }) => saved && showToast(done) },
  )
  const busy = exporter.busy

  const page = async (frame: DesignFrame): Promise<DesignExportFrame> => {
    const doc = await getDesignFrameHtml(workspaceId, design.id, frame.id, themeOf(frame))
    return { name: frame.name, html: doc.html, width: frame.width, height: frame.height }
  }

  const run = async (action: () => Promise<boolean>, done: ToastKey) => {
    await exporter.run({ action, done })
  }

  const title = (name: string) => t('canvas.export.saveTitle', { name })

  const htmlFiles = (frame: DesignFrame) => getDesignFrameSource(workspaceId, design.id, frame.id)

  return {
    busy,
    png: (frame: DesignFrame, scale: number) =>
      run(async () => {
        const saved = await window.milibot.exportDesignPng(await page(frame), scale, {
          defaultName: `${frame.name}${scale === 1 ? '' : `@${scale}x`}`,
          title: title(frame.name),
        })
        return saved !== null
      }, 'designExported'),
    pngZip: (frames: DesignFrame[], scale: number) =>
      run(async () => {
        const pages = await Promise.all(frames.map(page))
        const saved = await window.milibot.exportDesignPngZip(pages, scale, {
          defaultName: `${design.name}${scale === 1 ? '' : `@${scale}x`}`,
          title: title(design.name),
        })
        return saved !== null
      }, 'designExported'),
    pdf: (frames: DesignFrame[], name: string) =>
      run(async () => {
        const pages = await Promise.all(frames.map(page))
        const saved = await window.milibot.exportDesignPdf(pages, { defaultName: name, title: title(name) })
        return saved !== null
      }, 'designExported'),
    copy: (frame: DesignFrame, scale = 2) =>
      run(async () => {
        await window.milibot.copyDesignImage(await page(frame), scale)
        return true
      }, 'designCopied'),
    html: (frame: DesignFrame) =>
      run(async () => {
        const source = await htmlFiles(frame)
        const saved = await window.milibot.saveDesignHtml(
          { html: source.html, source: source.source, tokensCss: source.tokensCss },
          { defaultName: frame.name, title: title(frame.name) },
        )
        return saved !== null
      }, 'designExported'),
    htmlZip: (frames: DesignFrame[]) =>
      run(async () => {
        const sources = await Promise.all(frames.map(htmlFiles))
        const saved = await window.milibot.saveDesignHtmlZip(
          sources.map((s) => ({ name: s.name, html: s.html, source: s.source, tokensCss: s.tokensCss })),
          { defaultName: `${design.name} HTML`, title: title(design.name) },
        )
        return saved !== null
      }, 'designExported'),
    /** The whole design, or only `frame`, as a `.mbdesign` another workspace imports. */
    file: (frame?: DesignFrame) =>
      run(async () => {
        const name = frame?.name ?? design.name
        const path = await window.milibot.chooseDesignFilePath({ defaultName: name, title: title(name) })
        if (!path) return false
        await exportDesign(workspaceId, design.id, path, frame ? [frame.id] : undefined)
        return true
      }, 'designExported'),
  }
}

export type DesignExport = ReturnType<typeof useDesignExport>

function Row({
  icon,
  label,
  right,
  onClick,
  disabled,
}: {
  icon: ReactNode
  label: string
  right?: ReactNode
  onClick: () => void
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      onClick={onClick}
      className="focus-ring flex h-[28px] w-full items-center gap-[9px] rounded-md px-2 text-left text-base text-fg hover:bg-surface-3 disabled:opacity-45"
    >
      <span className="flex size-3.5 shrink-0 items-center text-fg-secondary">{icon}</span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {right}
    </button>
  )
}

function ScaleRow({
  label,
  disabled,
  onExport,
}: {
  label: string
  disabled: boolean
  onExport: (scale: number) => void
}) {
  const { t } = useTranslation()
  const [scale, setScale] = useState(readScale)
  const pick = (value: Scale) => {
    setScale(value)
    writePref(SCALE_KEY, value)
  }
  return (
    <div className="flex h-[33px] items-center gap-[9px] rounded-md px-2 hover:bg-surface-3">
      <button
        type="button"
        role="menuitem"
        disabled={disabled}
        onClick={() => onExport(Number(scale))}
        className="focus-ring flex min-w-0 flex-1 items-center gap-[9px] rounded text-left text-base text-fg disabled:opacity-45"
      >
        <ImageIcon size={14} className="shrink-0 text-fg-secondary" aria-hidden />
        <span className="truncate">{label}</span>
      </button>
      <Segmented
        value={scale}
        options={SCALES.map((value) => ({ value, label: `${value}×` }))}
        onChange={pick}
        label={t('canvas.export.scale')}
        size="xs"
        className="shrink-0 tabular-nums"
      />
    </div>
  )
}

function Heading({ children }: { children: ReactNode }) {
  return (
    <div className="truncate px-2 pt-1.5 pb-1 text-2xs font-semibold tracking-wide text-fg-muted uppercase">
      {children}
    </div>
  )
}

function Hint({ children }: { children: ReactNode }) {
  return (
    <>
      <div role="separator" className="mx-0 my-1 h-px bg-border" />
      <p className="px-2 pt-0.5 pb-1.5 text-xs leading-[1.4] text-fg-muted">{children}</p>
    </>
  )
}

/** The toolbar's "Export": every frame of the design (a `.mbdesign`, PNGs or HTML in a zip, one PDF). */
export function DesignExportPanel({
  frames,
  designName,
  actions,
  onDone,
}: {
  frames: DesignFrame[]
  designName: string
  actions: DesignExport
  onDone: () => void
}) {
  const { t } = useTranslation()
  const act = (action: () => Promise<void>) => {
    onDone()
    void action()
  }
  const empty = actions.busy || frames.length === 0
  return (
    <div className="flex w-[290px] flex-col" role="group" aria-label={t('canvas.export.title')}>
      <Heading>
        {designName} · {t('canvas.frames', { count: frames.length })}
      </Heading>
      <Row
        icon={<Package size={14} />}
        label={t('canvas.export.mbdesign')}
        disabled={actions.busy}
        onClick={() => act(() => actions.file())}
      />
      <ScaleRow
        label={t('canvas.export.pngZip')}
        disabled={empty}
        onExport={(scale) => act(() => actions.pngZip(frames, scale))}
      />
      <Row
        icon={<Files size={14} />}
        label={t('canvas.export.pdfAll')}
        disabled={empty}
        right={
          <span className="shrink-0 text-xs text-fg-muted">
            {t('canvas.export.pages', { count: frames.length })}
          </span>
        }
        onClick={() => act(() => actions.pdf(frames, designName))}
      />
      <Row
        icon={<FileCode size={14} />}
        label={t('canvas.export.htmlZip')}
        disabled={empty}
        onClick={() => act(() => actions.htmlZip(frames))}
      />
      <Hint>{t('canvas.export.mbdesignHint')}</Hint>
    </div>
  )
}

/** "Export" in a frame's menu: PNG at 1×/2×/3×, PDF, HTML + tokens.css, or the frame as a `.mbdesign`. */
export function FrameExportPanel({
  frame,
  actions,
  onDone,
}: {
  frame: DesignFrame
  actions: DesignExport
  onDone: () => void
}) {
  const { t } = useTranslation()
  const act = (action: () => Promise<void>) => {
    onDone()
    void action()
  }
  return (
    <div className="flex w-[290px] flex-col" role="group" aria-label={t('canvas.export.title')}>
      <Heading>
        {frame.name} · {frame.width}×{frame.height ?? t('canvas.auto')}
      </Heading>
      <ScaleRow
        label={t('canvas.export.png')}
        disabled={actions.busy}
        onExport={(scale) => act(() => actions.png(frame, scale))}
      />
      <Row
        icon={<FileText size={14} />}
        label={t('canvas.export.pdfFrame')}
        disabled={actions.busy}
        onClick={() => act(() => actions.pdf([frame], frame.name))}
      />
      <Row
        icon={<FileCode size={14} />}
        label={t('canvas.export.html')}
        disabled={actions.busy}
        onClick={() => act(() => actions.html(frame))}
      />
      <Row
        icon={<Package size={14} />}
        label={t('canvas.export.mbdesignFrame')}
        disabled={actions.busy}
        onClick={() => act(() => actions.file(frame))}
      />
      <Hint>{t('canvas.export.hint')}</Hint>
    </div>
  )
}
