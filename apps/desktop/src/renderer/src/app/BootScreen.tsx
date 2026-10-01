import { useTranslation } from 'react-i18next'

/** The main window before its workspace is loaded: a loading line, or the boot error with a retry. */
export function BootScreen({ error, onRetry }: { error?: string | null; onRetry?: () => void }) {
  const { t } = useTranslation()
  if (!onRetry) {
    return (
      <div className="drag-region flex h-full items-center justify-center text-base text-fg-muted">
        {t('app.loading')}
      </div>
    )
  }
  return (
    <div className="drag-region flex h-full flex-col items-center justify-center gap-3 px-10 text-center">
      <div className="text-lg font-semibold text-fg">{t('app.bootErrorTitle')}</div>
      <div className="selectable max-w-md font-mono text-sm leading-4 text-fg-muted">{error}</div>
      <button
        type="button"
        onClick={onRetry}
        className="no-drag rounded-lg bg-accent px-3 py-1.5 text-base font-semibold text-on-accent"
      >
        {t('app.retry')}
      </button>
    </div>
  )
}
