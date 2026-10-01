import {
  ArrowLeft,
  BookOpen,
  ChartColumn,
  ClipboardList,
  FolderKanban,
  GitBranch,
  KeyRound,
  Languages,
  Layers,
  Monitor,
  NotebookPen,
  Plug,
  Rocket,
  SlidersHorizontal,
  Sparkles,
} from 'lucide-react'
import { type ReactNode, useEffect } from 'react'
import { useTranslation } from 'react-i18next'

import { KnowledgeSettings } from '@/features/knowledge/KnowledgeSettings'
import { McpSettings } from '@/features/mcp/McpSettings'
import { MemorySettings } from '@/features/memory/MemorySettings'
import { PlansSettings } from '@/features/plans/PlansSettings'
import { ProjectsSettings } from '@/features/projects/ProjectsSettings'
import { ProvidersSettings } from '@/features/providers/ProvidersSettings'
import { SessionsSettings } from '@/features/sessions/SessionsSettings'
import { SkillsSettings } from '@/features/skills/SkillsSettings'
import { useSkillsStore } from '@/features/skills/store'
import { VmSettings } from '@/features/vm/settings/VmSettings'
import { screenIs, type SettingsSection, useAppStore, useCurrentWorkspace } from '@/features/workspace/store'
import { WorkspaceBadge } from '@/features/workspace/WorkspaceBadge'
import { WorkspacesSettings } from '@/features/workspace/WorkspacesSettings'
import { cn } from '@/lib/cn'
import { Tooltip } from '@/ui/Tooltip'

import { AppearanceSettings } from './AppearanceSettings'
import { CostsSettings } from './CostsSettings'
import { CredentialsSettings } from './CredentialsSettings'
import { GeneralSettings } from './GeneralSettings'
import { SettingsPage } from './SettingsLayout'

const SECTION_ICONS: Record<SettingsSection, ReactNode> = {
  general: <SlidersHorizontal size={15} aria-hidden />,
  providers: <KeyRound size={15} aria-hidden />,
  vm: <Monitor size={15} aria-hidden />,
  credentials: <GitBranch size={15} aria-hidden />,
  mcp: <Plug size={15} aria-hidden />,
  skills: <Sparkles size={15} aria-hidden />,
  projects: <FolderKanban size={15} aria-hidden />,
  knowledge: <BookOpen size={15} aria-hidden />,
  plans: <ClipboardList size={15} aria-hidden />,
  sessions: <Rocket size={15} aria-hidden />,
  memory: <NotebookPen size={15} aria-hidden />,
  costs: <ChartColumn size={15} aria-hidden />,
  workspaces: <Layers size={15} aria-hidden />,
  appearance: <Languages size={15} aria-hidden />,
}

const WORKSPACE_SECTIONS: SettingsSection[] = [
  'general',
  'providers',
  'vm',
  'credentials',
  'mcp',
  'skills',
  'projects',
  'knowledge',
  'plans',
  'sessions',
  'memory',
  'costs',
]
const APP_SECTIONS: SettingsSection[] = ['workspaces', 'appearance']

function Section({ section }: { section: SettingsSection }) {
  const { t } = useTranslation()
  switch (section) {
    case 'general':
      return <GeneralSettings />
    case 'providers':
      return <ProvidersSettings />
    case 'vm':
      return <VmSettings />
    case 'credentials':
      return <CredentialsSettings />
    case 'mcp':
      return <McpSettings />
    case 'skills':
      return <SkillsSettings />
    case 'projects':
      return <ProjectsSettings />
    case 'knowledge':
      return <KnowledgeSettings />
    case 'plans':
      return <PlansSettings />
    case 'sessions':
      return <SessionsSettings />
    case 'memory':
      return <MemorySettings />
    case 'costs':
      return <CostsSettings />
    case 'workspaces':
      return <WorkspacesSettings />
    case 'appearance':
      return (
        <SettingsPage
          title={t('settings.sections.appearance')}
          subtitle={t('settings.appearanceSubtitle')}
          width="narrow"
        >
          <AppearanceSettings />
        </SettingsPage>
      )
  }
}

/** Full-window settings: section nav on the left, the section on the right. */
export function SettingsScreen() {
  const { t } = useTranslation()
  const section = useAppStore((s) => screenIs(s.screen, 'settings')?.section) ?? 'general'
  const openSettings = useAppStore((s) => s.openSettings)
  const closeSettings = useAppStore((s) => s.closeSettings)
  const workspace = useCurrentWorkspace()

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (
        event.key === 'Escape' &&
        !event.defaultPrevented &&
        !document.querySelector('[data-menu]') &&
        !document.querySelector('[role="dialog"]')
      )
        closeSettings()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [closeSettings])

  const item = (id: SettingsSection) => {
    const current = id === section
    return (
      <button
        key={id}
        type="button"
        aria-current={current ? 'page' : undefined}
        onClick={() => {
          if (id === 'skills') useSkillsStore.getState().openSkill(null)
          openSettings(id)
        }}
        className={cn(
          'focus-inset flex h-8 w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-base',
          current ? 'bg-surface-3 font-semibold text-fg' : 'text-fg-secondary hover:bg-surface-3/60',
        )}
      >
        {SECTION_ICONS[id]}
        <span className="truncate">{t(`settings.sections.${id}`)}</span>
      </button>
    )
  }

  return (
    <div className="flex h-full min-w-0 flex-1">
      <nav
        aria-label={t('settings.title')}
        className="flex w-60 shrink-0 flex-col border-r border-border bg-surface pb-5"
      >
        {/* Title-bar zone: draggable, clear of the traffic lights on macOS. */}
        <div className="drag-region h-3 shrink-0 mac:h-[46px]" />
        <div className="flex flex-col gap-0.5 px-3">
          <Tooltip content={t('settings.backHint')} side="bottom">
            <button
              type="button"
              onClick={closeSettings}
              aria-label={t('settings.back')}
              className="group no-drag focus-ring mb-1 flex w-fit cursor-pointer items-center gap-1.5 rounded-lg px-2 py-1 text-lg font-bold text-fg transition-colors hover:bg-surface-3"
            >
              <ArrowLeft
                size={14}
                className="text-fg-secondary transition-transform group-hover:-translate-x-0.5 motion-reduce:transition-none motion-reduce:group-hover:translate-x-0"
                aria-hidden
              />
              {t('settings.title')}
            </button>
          </Tooltip>
          <div className="flex items-center gap-1.5 px-2 pt-3 pb-1.5">
            {workspace && (
              <WorkspaceBadge name={workspace.name} color={workspace.color} icon={workspace.icon} size={16} />
            )}
            <span className="truncate text-2xs font-semibold tracking-[0.04em] text-fg-muted uppercase">
              {t('settings.workspaceGroup', { name: workspace?.name ?? '' })}
            </span>
          </div>
          {WORKSPACE_SECTIONS.map(item)}
          <div className="px-2 pt-3 pb-1.5 text-2xs font-semibold tracking-[0.04em] text-fg-muted uppercase">
            {t('settings.appGroup')}
          </div>
          {APP_SECTIONS.map(item)}
        </div>
      </nav>
      <main className="scroll-slim relative min-w-0 flex-1 overflow-y-auto bg-bg">
        {/* Windows: taller, and the page starts below the caption buttons. */}
        <div className="drag-region sticky top-0 z-sticky -mb-7 h-7 win:-mb-10 win:h-10" />
        <div className="px-12 pt-7 pb-10 win:pt-11">
          <Section key={`${workspace?.id}-${section}`} section={section} />
        </div>
      </main>
    </div>
  )
}
