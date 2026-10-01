import { Minus, Plus, Scan } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { zoomPercent } from '@/lib/viewport'

import { Tooltip } from './Tooltip'

/** − zoom % + and "Fit"; `className` places it. */
export function ZoomControls({
  zoom,
  onStep,
  onActualSize,
  onFit,
  className,
}: {
  zoom: number
  onStep: (direction: 1 | -1) => void
  onActualSize: () => void
  onFit: () => void
  className: string
}) {
  const { t } = useTranslation()
  return (
    <div
      className={`flex h-[25px] items-center gap-0.5 rounded-[9px] border border-border bg-surface-2 px-1 shadow-[0_2px_6px_rgba(0,0,0,0.06)] ${className}`}
      onPointerDown={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
    >
      <Tooltip content={t('canvas.zoomOut')}>
        <button
          type="button"
          aria-label={t('canvas.zoomOut')}
          onClick={() => onStep(-1)}
          className="focus-ring flex size-5 items-center justify-center rounded text-fg-secondary hover:bg-surface-3"
        >
          <Minus size={13} />
        </button>
      </Tooltip>
      <Tooltip content={t('canvas.actualSize')}>
        <button
          type="button"
          aria-label={t('canvas.zoomLevel', { percent: zoomPercent(zoom) })}
          onClick={onActualSize}
          className="focus-ring min-w-[36px] rounded px-0.5 text-center text-sm font-semibold text-fg tabular-nums hover:bg-surface-3"
        >
          {zoomPercent(zoom)}%
        </button>
      </Tooltip>
      <Tooltip content={t('canvas.zoomIn')}>
        <button
          type="button"
          aria-label={t('canvas.zoomIn')}
          onClick={() => onStep(1)}
          className="focus-ring flex size-5 items-center justify-center rounded text-fg-secondary hover:bg-surface-3"
        >
          <Plus size={13} />
        </button>
      </Tooltip>
      <span className="mx-1 h-3.5 w-px bg-border" aria-hidden />
      <button
        type="button"
        onClick={onFit}
        className="focus-ring flex h-5 items-center gap-1 rounded px-1 text-sm text-fg-secondary hover:bg-surface-3"
      >
        <Scan size={12} aria-hidden />
        {t('canvas.fit')}
      </button>
    </div>
  )
}
