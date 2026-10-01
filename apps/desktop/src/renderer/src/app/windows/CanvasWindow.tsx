import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'

import { CanvasView } from '@/features/canvas/CanvasView'
import { useDesignStore } from '@/features/canvas/store'
import { useAppStore } from '@/features/workspace/store'

/** "Open in window": only the canvas of a design, following the same events as the main window. */
export function CanvasWindow({ params }: { params: URLSearchParams }) {
  const { t } = useTranslation()
  const designId = params.get('design') ?? ''
  const phase = useAppStore((s) => s.phase)
  const boot = useAppStore((s) => s.boot)
  const name = useDesignStore((s) => s.details[designId]?.name)

  useEffect(() => {
    void boot({ chat: false })
  }, [boot])

  useEffect(() => {
    if (name) document.title = name
  }, [name])

  if (phase !== 'ready')
    return (
      <div className="drag-region flex h-full items-center justify-center bg-surface text-base text-fg-muted">
        {phase === 'error' ? t('app.bootErrorTitle') : t('app.loading')}
      </div>
    )
  return (
    <div className="flex h-full">
      <CanvasView designId={designId} conversationId={null} windowMode onClose={() => window.close()} />
    </div>
  )
}
