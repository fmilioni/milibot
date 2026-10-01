import { type Bot, type BotControlAction, type BotDisplay } from '@milibot/shared'
import { GraduationCap, Hand, LoaderCircle, Pause, Play, Power, Square, Undo2 } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { useAppStore } from '@/features/workspace/store'
import { cn } from '@/lib/cn'
import { Button } from '@/ui/Button'

import { TakeOverOverlay } from './TakeOverOverlay'
import { type TeachSession, useTeachStore } from './teach-store'
import { TeachStartDialog } from './TeachStartDialog'
import { type DisplayState, openVmWindow } from './use-bot-display'
import { type VncStatus, VncViewer } from './VncViewer'

export function Screen({
  bot,
  state,
  teaching,
  onChanged,
}: {
  bot: Bot | null
  state: DisplayState
  teaching: TeachSession | null
  onChanged: () => void
}) {
  const { t } = useTranslation()
  const vm = useAppStore((s) => s.vm)
  const startVm = useAppStore((s) => s.startVm)
  const workspaceId = useAppStore((s) => s.workspaceId)
  const controlBot = useAppStore((s) => s.controlBot)
  const showToast = useAppStore((s) => s.showToast)
  const teachDispatch = useTeachStore((s) => s.dispatch)
  const [status, setStatus] = useState<VncStatus>('connecting')
  const [starting, setStarting] = useState(false)
  const [takingOver, setTakingOver] = useState(false)

  let overlay: React.ReactNode = null
  if (!vm) {
    overlay = <ScreenMessage title={t('panels.vm.unavailableTitle')} hint={t('panels.vm.unavailableHint')} />
  } else if (vm.state === 'starting' || vm.state === 'stopping' || starting) {
    overlay = (
      <ScreenMessage
        icon={<LoaderCircle size={18} className="animate-spin text-fg-muted motion-reduce:animate-none" />}
        title={t(`panels.vm.state.${vm.state === 'stopping' ? 'stopping' : 'starting'}`)}
      />
    )
  } else if (vm.state !== 'running') {
    overlay = (
      <ScreenMessage
        title={t(`panels.vm.state.${vm.state}`)}
        hint={vm.state === 'error' ? (vm.error ?? '') : t('panels.vm.startHint')}
        action={
          <Button
            size="sm"
            variant="primary"
            onClick={() => {
              setStarting(true)
              void startVm().finally(() => setStarting(false))
            }}
          >
            <Power size={13} />
            {t('panels.vm.start')}
          </Button>
        }
      />
    )
  } else if (!bot) {
    overlay = <ScreenMessage title={t('panels.vm.noBot')} />
  } else if (state.kind === 'loading') {
    overlay = (
      <ScreenMessage
        icon={<LoaderCircle size={18} className="animate-spin text-fg-muted motion-reduce:animate-none" />}
        title={t('panels.vm.connecting')}
      />
    )
  } else if (state.kind === 'unavailable') {
    overlay = (
      <ScreenMessage
        title={state.reason === 'not_ready' ? t('panels.vm.desktopNotReady') : t('panels.vm.desktopError')}
        hint={t('panels.vm.desktopHint')}
      />
    )
  }

  const ready = state.kind === 'ready' && vm?.state === 'running' && bot
  const userControl = ready && state.display.control === 'user'
  const viewOnly = !userControl
  const paused = ready && state.display.paused && !userControl
  const connected = ready && status === 'connected'
  const takeOver = async () => {
    if (!bot || !workspaceId) return
    setTakingOver(true)
    try {
      await controlBot(bot.id, 'takeover')
      openVmWindow(workspaceId, bot, t)
    } catch {
      showToast('error')
    } finally {
      setTakingOver(false)
      onChanged()
    }
  }
  return (
    <div
      className={cn(
        'relative aspect-[1280/800] w-full shrink-0 overflow-hidden rounded-lg border bg-[linear-gradient(200deg,#1E2A44,#2B1E3A)]',
        teaching && !teaching.recording.paused ? 'border-danger' : 'border-border',
      )}
    >
      {ready && workspaceId && (
        <VncViewer
          workspaceId={workspaceId}
          botId={bot.id}
          viewOnly={viewOnly}
          label={t('panels.vm.screenLabel', { name: bot.name })}
          onStatus={setStatus}
          {...(teaching ? { onInput: teachDispatch } : {})}
        />
      )}
      {ready && status !== 'connected' && (
        <ScreenMessage
          icon={
            <LoaderCircle
              size={18}
              className="animate-spin text-screen-fg-secondary motion-reduce:animate-none"
            />
          }
          title={status === 'connecting' ? t('panels.vm.connecting') : t('panels.vm.reconnecting')}
        />
      )}
      {connected && paused && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-screen/65 px-10 text-center">
          <Pause size={18} className="text-screen-fg" />
          <span className="text-base font-semibold text-screen-fg">{t('panels.vm.paused.title')}</span>
          <span className="max-w-xs text-sm leading-4 text-screen-fg-secondary">
            {t('panels.vm.paused.hint')}
          </span>
          <div className="mt-1 flex gap-2">
            <Button
              size="sm"
              variant="primary"
              onClick={() => void controlBot(bot.id, 'resume').finally(onChanged)}
            >
              <Play size={13} />
              {t('panels.vm.paused.resume')}
            </Button>
            <Button size="sm" disabled={takingOver} onClick={() => void takeOver()}>
              <Hand size={13} />
              {t('panels.vm.takeOver')}
            </Button>
          </div>
        </div>
      )}
      {connected && viewOnly && !paused && !teaching && (
        <TakeOverOverlay busy={takingOver} onTakeOver={() => void takeOver()} />
      )}
      {overlay}
      {ready && (
        <span className="pointer-events-none absolute bottom-2 left-2 rounded bg-scrim-strong px-1.5 py-0.5 font-mono text-3xs text-screen-fg-secondary">
          1280×800 · :{state.display.display}
        </span>
      )}
    </div>
  )
}

function ScreenMessage({
  icon,
  title,
  hint,
  action,
}: {
  icon?: React.ReactNode
  title: string
  hint?: string
  action?: React.ReactNode
}) {
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-10 text-center">
      {icon}
      <span className="text-base font-semibold text-screen-fg">{title}</span>
      {hint && <span className="max-w-sm text-sm leading-4 text-screen-fg-secondary">{hint}</span>}
      {action && <div className="mt-1">{action}</div>}
    </div>
  )
}

export function Controls({
  bot,
  display,
  conversationId,
  onChanged,
}: {
  bot: Bot
  display: BotDisplay
  conversationId: string | null
  onChanged: () => void
}) {
  const { t } = useTranslation()
  const controlBot = useAppStore((s) => s.controlBot)
  const showToast = useAppStore((s) => s.showToast)
  const [busy, setBusy] = useState<BotControlAction | null>(null)
  const [teaching, setTeaching] = useState(false)

  const run = async (action: BotControlAction) => {
    setBusy(action)
    try {
      await controlBot(bot.id, action)
    } catch {
      showToast('error')
    } finally {
      setBusy(null)
      onChanged()
    }
  }

  const userInControl = display.control === 'user'
  return (
    <div className="flex shrink-0 flex-wrap gap-2">
      {display.paused && !userInControl ? (
        <Button size="sm" className="h-[31px]" disabled={busy !== null} onClick={() => void run('resume')}>
          <Play size={14} />
          {t('panels.vm.resumeBot')}
        </Button>
      ) : (
        <Button
          size="sm"
          className="h-[31px]"
          disabled={busy !== null || userInControl}
          onClick={() => void run('pause')}
        >
          <Pause size={14} />
          {t('panels.vm.pauseBot')}
        </Button>
      )}
      {userInControl && (
        <Button
          size="sm"
          variant="primary"
          className="h-[31px]"
          disabled={busy !== null}
          onClick={() => void run('release')}
        >
          <Undo2 size={14} />
          {t('panels.vm.release')}
        </Button>
      )}
      <Button size="sm" className="h-[31px]" disabled={busy !== null} onClick={() => setTeaching(true)}>
        <GraduationCap size={14} />
        {t('panels.vm.teach')}
      </Button>
      {/* Only while there is a task to stop; last in the row so nothing else moves when it shows up. */}
      {(display.busy || busy === 'stop') && (
        <Button
          size="sm"
          variant="danger-outline"
          className="h-[31px]"
          disabled={busy !== null}
          onClick={() => void run('stop')}
        >
          {busy === 'stop' ? (
            <LoaderCircle size={14} className="animate-spin motion-reduce:animate-none" />
          ) : (
            <Square size={14} />
          )}
          {busy === 'stop' ? t('panels.vm.stopping') : t('panels.vm.stopTask')}
        </Button>
      )}
      {teaching && (
        <TeachStartDialog
          bot={bot}
          conversationId={conversationId}
          userHasControl={userInControl}
          onClose={() => {
            setTeaching(false)
            onChanged()
          }}
        />
      )}
    </div>
  )
}
