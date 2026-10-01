import '@fontsource/inter/400.css'
import '@fontsource/inter/500.css'
import '@fontsource/inter/600.css'
import '@fontsource/inter/700.css'
import '@fontsource/jetbrains-mono/400.css'
import '@fontsource/jetbrains-mono/500.css'
import '@/styles.css'
import '@/i18n'

import { QueryClientProvider } from '@tanstack/react-query'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import { queryClient } from '@/api/query-client'
import { errorReport, reportError } from '@/lib/error-report'
import { startThemeSync } from '@/lib/theme'
import { startTitleBarSync } from '@/lib/title-bar'
import { CrashScreen, ErrorBoundary } from '@/ui/ErrorBoundary'

import { App } from './App'
import { registerSubscriptions } from './subscriptions'

document.documentElement.dataset.platform = window.milibot?.platform ?? 'darwin'
startThemeSync()
if (window.milibot?.platform === 'win32')
  startTitleBarSync((colors) => window.milibot.setTitleBarOverlay(colors))

window.addEventListener('error', (event) => reportError(errorReport('error', event.error ?? event.message)))
window.addEventListener('unhandledrejection', (event) => reportError(errorReport('rejection', event.reason)))

registerSubscriptions()

const root = document.getElementById('root')
if (!root) throw new Error('#root not found')

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ErrorBoundary area="window" fallback={(_retry, error) => <CrashScreen error={error} />}>
        <App />
      </ErrorBoundary>
    </QueryClientProvider>
  </StrictMode>,
)
