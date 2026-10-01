import type { ComponentProps } from 'react'

import { PanelHeader } from '@/ui/PanelHeader'

import { useAppStore } from './store'

/**
 * The header of a right panel, closing it. A compact header only closes in the session screen: in the chat a
 * header button toggles the compact panels.
 */
export function RightPanelHeader(props: Omit<ComponentProps<typeof PanelHeader>, 'onClose'>) {
  const toggle = useAppStore((s) => s.toggleRightPanel)
  const panel = useAppStore((s) => s.rightPanel)
  const inSession = useAppStore((s) => s.screen.kind === 'session')
  const closable = props.variant === 'bar' || inSession
  return <PanelHeader {...props} onClose={closable ? () => panel && toggle(panel) : undefined} />
}
