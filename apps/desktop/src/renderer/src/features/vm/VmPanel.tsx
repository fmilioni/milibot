import { type BotDisplay } from '@milibot/shared'
import { Maximize2 } from 'lucide-react'
import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'

import { vmPanelBot } from '@/features/vm/lib/screen-control'
import { RightPanelHeader } from '@/features/workspace/RightPanelHeader'
import { screenIs, useAppStore, useSelectedConversation } from '@/features/workspace/store'
import { cn } from '@/lib/cn'
import { Tooltip } from '@/ui/Tooltip'

import { ActivityLog } from './ActivityLog'
import { useTeachStore } from './teach-store'
import { GeneratingProcedures, RecordingBar } from './TeachPanel'
import { TeachSteps } from './TeachSteps'
import { openVmWindow, useBotDisplay } from './use-bot-display'
import { VmPowerMenu } from './VmPowerMenu'
import { Controls, Screen } from './VmScreen'

export function VmPanel() {
  const { t } = useTranslation()
  const conversation = useSelectedConversation()
  const bots = useAppStore((s) => s.bots)
  const vm = useAppStore((s) => s.vm)
  const workspaceId = useAppStore((s) => s.workspaceId)
  const vmBotId = useAppStore((s) => s.vmBotId)
  const teach = useTeachStore((s) => s.session)
  const scroller = useRef<HTMLDivElement>(null)
  const sessionBotId = useAppStore((s) => screenIs(s.screen, 'session')?.botId ?? null)
  const bot = vmPanelBot({ conversation, bots, vmBotId, sessionBotId })
  const vmRunning = vm?.state === 'running'
  const { state, refresh } = useBotDisplay(bot, vmRunning)
  const control =
    state.kind !== 'ready'
      ? 'idle'
      : state.display.paused && state.display.control !== 'user'
        ? 'paused'
        : state.display.control
  const teaching = bot && teach?.botId === bot.id ? teach : null
  const teachingProcedure = teaching?.procedureId ?? null
  // Starting and ending a recording takes and gives back the screen.
  useEffect(() => {
    void refresh()
  }, [teachingProcedure, refresh])

  return (
    <>
      <RightPanelHeader
        title={bot ? t('panels.vm.title', { name: bot.name }) : t('panels.vm.titleNoBot')}
        badge={
          teaching ? (
            <TeachBadge paused={teaching.recording.paused} />
          ) : state.kind === 'ready' ? (
            <ControlBadge control={control} />
          ) : undefined
        }
        actions={
          <>
            {bot && workspaceId && (
              <Tooltip content={t('vmWindow.open')}>
                <button
                  type="button"
                  onClick={() => openVmWindow(workspaceId, bot, t)}
                  aria-label={t('vmWindow.open')}
                  className="focus-ring rounded text-fg-secondary hover:text-fg"
                >
                  <Maximize2 size={15} />
                </button>
              </Tooltip>
            )}
            <VmPowerMenu />
          </>
        }
      />
      {/* Screen and controls stay put; only the log (or the recorded steps) scrolls below them. */}
      <div className="flex min-h-0 flex-1 flex-col gap-3.5 px-4 pb-4">
        <Screen bot={bot} state={state} teaching={teaching} onChanged={() => void refresh()} />
        {bot && teaching && <RecordingBar bot={bot} session={teaching} />}
        {bot && !teaching && state.kind === 'ready' && (
          <Controls
            bot={bot}
            display={state.display}
            conversationId={conversation?.id ?? null}
            onChanged={() => void refresh()}
          />
        )}
        {bot && (teaching || state.kind === 'ready') && (
          <p className="shrink-0 text-sm leading-[1.5] text-fg-muted">
            {teaching ? t('teach.hint') : t(`panels.vm.hint.${control}`)}
          </p>
        )}
        {bot && <GeneratingProcedures bot={bot} />}
        {bot && (
          <div
            ref={scroller}
            className="scroll-slim -mr-2 min-h-0 flex-1 overflow-y-auto pr-2 [scrollbar-gutter:stable]"
          >
            {teaching ? <TeachSteps session={teaching} scroller={scroller} /> : <ActivityLog bot={bot} />}
          </div>
        )}
      </div>
    </>
  )
}

function TeachBadge({ paused }: { paused: boolean }) {
  const { t } = useTranslation()
  return (
    <span
      className={cn(
        'flex h-[19px] items-center gap-[5px] rounded-full px-2 text-xs font-semibold',
        paused ? 'bg-surface-3 text-fg-muted' : 'bg-danger-tint text-danger',
      )}
    >
      <span className={cn('size-1.5 rounded-full', paused ? 'bg-fg-muted' : 'bg-danger')} />
      {paused ? t('panels.vm.teachPausedBadge') : t('panels.vm.teachBadge')}
    </span>
  )
}

function ControlBadge({ control }: { control: BotDisplay['control'] | 'paused' }) {
  const { t } = useTranslation()
  const styles = {
    bot: 'bg-success-soft text-success',
    user: 'bg-accent-soft text-accent',
    idle: 'bg-surface-3 text-fg-muted',
    paused: 'bg-warning-tint text-warning',
  }[control]
  const dot = { bot: 'bg-success', user: 'bg-accent', idle: 'bg-fg-muted', paused: 'bg-warning' }[control]
  return (
    <span
      className={`flex h-[19px] items-center gap-[5px] rounded-full px-2 text-xs font-semibold ${styles}`}
    >
      <span className={`size-1.5 rounded-full ${dot}`} />
      {t(`panels.vm.control.${control}`)}
    </span>
  )
}
