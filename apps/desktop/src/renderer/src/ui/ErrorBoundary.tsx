import { CircleAlert, RotateCcw } from 'lucide-react'
import { Component, type ErrorInfo, type ReactNode, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { cn } from '@/lib/cn'
import { errorReport, reportError } from '@/lib/error-report'

import { Button } from './Button'

interface ErrorBoundaryProps {
  /** Names the area in the log. */
  area: string
  /** The area shows something else (another conversation, panel…): try rendering again. */
  resetKey?: unknown
  fallback: (retry: () => void, error: Error) => ReactNode
  children: ReactNode
}

/** Keeps a render error inside its area: logs it (`renderer.log`) and shows `fallback` instead. */
export class ErrorBoundary extends Component<ErrorBoundaryProps, { error: Error | null }> {
  override state: { error: Error | null } = { error: null }

  static getDerivedStateFromError(error: unknown) {
    return { error: error instanceof Error ? error : new Error(String(error)) }
  }

  override componentDidCatch(error: unknown, info: ErrorInfo) {
    reportError(errorReport('render', error, { area: this.props.area, componentStack: info.componentStack }))
  }

  override componentDidUpdate(previous: ErrorBoundaryProps) {
    if (this.state.error && previous.resetKey !== this.props.resetKey) this.setState({ error: null })
  }

  override render() {
    const { error } = this.state
    return error ? this.props.fallback(() => this.setState({ error: null }), error) : this.props.children
  }
}

/** The whole window failed: offer a reload (the state lives in the daemon) and the details to share. */
export function CrashScreen({ error }: { error: Error }) {
  const { t } = useTranslation()
  const [copied, setCopied] = useState(false)
  const details = `${error.name}: ${error.message}\n${error.stack ?? ''}`
  return (
    <div className="drag-region flex h-full flex-col items-center justify-center gap-3 bg-bg px-10 text-center">
      <CircleAlert size={22} className="text-fg-muted" />
      <div className="text-lg font-semibold text-fg">{t('app.crash.title')}</div>
      <div className="max-w-md text-base text-fg-secondary">{t('app.crash.body')}</div>
      <div className="no-drag mt-1 flex gap-2">
        <Button variant="primary" onClick={() => window.location.reload()}>
          <RotateCcw size={14} />
          {t('app.crash.reload')}
        </Button>
        <Button
          onClick={() =>
            void navigator.clipboard.writeText(details).then(() => {
              setCopied(true)
              setTimeout(() => setCopied(false), 2000)
            })
          }
        >
          {copied ? t('app.crash.copied') : t('app.crash.copyDetails')}
        </Button>
      </div>
    </div>
  )
}

/** A part of the screen failed; the rest keeps working. */
export function AreaError({
  onRetry,
  message,
  inline = false,
  className = '',
}: {
  onRetry: () => void
  message?: string
  /** One row (a message in the chat) instead of a centered block. */
  inline?: boolean
  className?: string
}) {
  const { t } = useTranslation()
  return (
    <div
      className={cn(
        'flex gap-2',
        inline ? 'items-center' : 'flex-col items-center justify-center p-6 text-center',
        className,
      )}
    >
      <span className="flex items-center gap-1.5 text-base text-fg-secondary">
        <CircleAlert size={14} className="shrink-0 text-fg-muted" />
        {message ?? t('app.areaError')}
      </span>
      <Button size="sm" onClick={onRetry}>
        {t('common.retry')}
      </Button>
    </div>
  )
}
