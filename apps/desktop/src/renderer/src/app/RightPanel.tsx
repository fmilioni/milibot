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
  const width = panel === 'debug' ? 'w-[min(660px,52vw)]' : 'w-[min(var(--right-panel-width),40vw)]'
  return (
    <aside className={`flex shrink-0 flex-col border-l border-border bg-surface ${width}`}>
      <RightPanelContent panel={panel} />
    </aside>
  )
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
