import { type ReactNode, useEffect } from 'react'

import { BootScreen } from '@/app/BootScreen'
import { ModalHost } from '@/app/ModalHost'
import { ReconnectingBanner } from '@/app/ReconnectingBanner'
import { RightPanel, rightPanelWidth } from '@/app/RightPanel'
import { Toaster } from '@/app/Toaster'
import { BoardsScreen } from '@/features/boards/BoardsScreen'
import { CanvasScreen } from '@/features/canvas/CanvasScreen'
import { ChatPanel } from '@/features/chat/ChatPanel'
import { DesignsScreen } from '@/features/designs/DesignsScreen'
import { FilesScreen } from '@/features/files/FilesScreen'
import { SessionScreen } from '@/features/sessions/SessionScreen'
import { SettingsScreen } from '@/features/settings/SettingsScreen'
import { SetupScreen } from '@/features/setup/SetupScreen'
import { Sidebar } from '@/features/sidebar/Sidebar'
import { type NavScreen, useAppStore } from '@/features/workspace/store'
import { useReducedMotion } from '@/features/workspace/use-reduced-motion'
import { AreaError, ErrorBoundary } from '@/ui/ErrorBoundary'

/** A part of the main window that fails on its own: the fallback keeps the part's place in the layout. */
function Area({
  name,
  resetKey,
  className,
  children,
}: {
  name: string
  resetKey?: unknown
  className: string
  children: ReactNode
}) {
  return (
    <ErrorBoundary
      area={name}
      resetKey={resetKey}
      fallback={(retry) => <AreaError onRetry={retry} className={className} />}
    >
      {children}
    </ErrorBoundary>
  )
}

const CENTER = 'min-w-0 flex-1'

const NAV_SCREENS: Record<NavScreen['kind'], ReactNode> = {
  boards: <BoardsScreen />,
  designs: <DesignsScreen />,
  files: <FilesScreen />,
}

export function MainWindow() {
  const phase = useAppStore((s) => s.phase)
  const bootError = useAppStore((s) => s.bootError)
  const boot = useAppStore((s) => s.boot)
  const reducedMotion = useReducedMotion()
  const inSetup = useAppStore((s) => s.workspaces.find((w) => w.id === s.workspaceId)?.setup !== 'done')

  useEffect(() => {
    void boot()
  }, [boot])

  useEffect(() => {
    document.documentElement.toggleAttribute('data-reduced-motion', reducedMotion)
  }, [reducedMotion])

  if (phase === 'booting') return <BootScreen />
  if (phase === 'error') return <BootScreen error={bootError} onRetry={() => void boot()} />

  return (
    <div className="relative flex h-full">
      {inSetup ? (
        <Area name="setup" className={CENTER}>
          <SetupScreen />
        </Area>
      ) : (
        <WindowScreen />
      )}
      <ModalHost />
      <ReconnectingBanner />
      <Toaster />
    </div>
  )
}

/** The screen the navigation shows (`screen` in the app store). */
function WindowScreen() {
  const kind = useAppStore((s) => s.screen.kind)
  const conversationId = useAppStore((s) => s.selectedConversationId)
  const rightPanel = useAppStore((s) => s.rightPanel)

  const center = (node: ReactNode) => (
    <Area name={kind} resetKey={`${kind}:${conversationId}`} className={CENTER}>
      {node}
    </Area>
  )
  const sidebar = (
    <Area name="sidebar" className="w-[var(--sidebar-width)] shrink-0 border-r border-border bg-surface">
      <Sidebar />
    </Area>
  )
  const right = (
    <Area
      name="right-panel"
      resetKey={rightPanel}
      className={`${rightPanelWidth(rightPanel)} shrink-0 border-l border-border bg-surface`}
    >
      <RightPanel />
    </Area>
  )

  switch (kind) {
    case 'settings':
      return center(<SettingsScreen />)
    case 'canvas':
      return center(<CanvasScreen />)
    case 'boards':
    case 'designs':
    case 'files':
      return (
        <>
          {sidebar}
          {center(NAV_SCREENS[kind])}
        </>
      )
    case 'session':
      return (
        <>
          {sidebar}
          {center(<SessionScreen />)}
          {rightPanel === 'debug' && right}
        </>
      )
    case 'chat':
      return (
        <>
          {sidebar}
          {center(<ChatPanel />)}
          {right}
        </>
      )
  }
}
