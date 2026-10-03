import { useTranslation } from 'react-i18next'

import { BotSettingsPanel } from '@/features/bots/BotSettingsPanel'
import { InternalPanel } from '@/features/chat/InternalPanel'
import { MembersPanel } from '@/features/chat/MembersPanel'
import { DebugPanel } from '@/features/debug/DebugPanel'
import { AppearanceSettings } from '@/features/settings/AppearanceSettings'
import { VmPanel } from '@/features/vm/VmPanel'
import { RightPanelHeader } from '@/features/workspace/RightPanelHeader'
import { type RightPanel as RightPanelKind, useAppStore } from '@/features/workspace/store'

export function RightPanel() {
  const panel = useAppStore((s) => s.rightPanel)
  if (!panel) return null
  return (
    <aside className={`flex shrink-0 flex-col border-l border-border bg-surface ${rightPanelWidth(panel)}`}>
      <RightPanelContent panel={panel} />
    </aside>
  )
}

/** The right panel's width class, also kept by its area's error fallback. */
export function rightPanelWidth(panel: RightPanelKind | null): string {
  return panel === 'debug' ? 'w-[var(--debug-panel-width)]' : 'w-[min(var(--right-panel-width),40vw)]'
}

/** A right panel's content, without its column (the session screen shows it in its own). */
export function RightPanelContent({ panel }: { panel: RightPanelKind }) {
  switch (panel) {
    case 'vm':
      return <VmPanel />
    case 'debug':
      return <DebugPanel />
    case 'bot':
      return <BotSettingsPanel />
    case 'settings':
      return <AppSettingsPanel />
    case 'members':
      return <MembersPanel />
    case 'internal':
      return <InternalPanel />
  }
}

function AppSettingsPanel() {
  const { t } = useTranslation()
  return (
    <>
      <RightPanelHeader variant="bar" title={t('panels.settings.title')} />
      <div className="scroll-slim overflow-y-auto p-4">
        <AppearanceSettings />
      </div>
    </>
  )
}
