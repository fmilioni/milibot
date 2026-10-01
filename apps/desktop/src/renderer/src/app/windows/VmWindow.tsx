import { type ApiClient, type Bot, type BotDisplay, createApiClient } from '@milibot/shared'
import { Maximize, Minimize, Undo2, X } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { TakeOverOverlay } from '@/features/vm/TakeOverOverlay'
import { type VncStatus, VncViewer } from '@/features/vm/VncViewer'
import { setLanguage } from '@/i18n'
import { cn } from '@/lib/cn'
import { setThemePreference } from '@/lib/theme'
import { type Tone, TONE_SOFT } from '@/lib/tone'
import { Button } from '@/ui/Button'
import { Spinner } from '@/ui/Spinner'
import { StatusDot } from '@/ui/Tag'
import { Tooltip } from '@/ui/Tooltip'

const REFRESH_MS = 3000

const CONTROL_TONE: Record<BotDisplay['control'], Tone> = { bot: 'success', user: 'accent', idle: 'muted' }

type Load =
  | { kind: 'loading' }
  | { kind: 'ready'; client: ApiClient; bot: Bot; display: BotDisplay }
  | { kind: 'error' }

function useFullScreen(): [boolean, () => void] {
  const [full, setFull] = useState(Boolean(document.fullscreenElement))
  useEffect(() => {
    const onChange = () => setFull(Boolean(document.fullscreenElement))
    document.addEventListener('fullscreenchange', onChange)
    return () => document.removeEventListener('fullscreenchange', onChange)
  }, [])
  const toggle = () => {
    if (document.fullscreenElement) void document.exitFullscreen()
    else void document.documentElement.requestFullscreen()
  }
  return [full, toggle]
}

/**
 * A bot's desktop in its own window (1280×800 at 1:1 when the screen allows). In `login` mode the
 * user has the screen from the start; otherwise the bot keeps it until "Take control".
 */
export function VmWindow({ params }: { params: URLSearchParams }) {
  const { t } = useTranslation()
  const workspaceId = params.get('workspace') ?? ''
  const botId = params.get('bot') ?? ''
  const loginMode = params.get('mode') === 'login'
  const [load, setLoad] = useState<Load>({ kind: 'loading' })
  const [status, setStatus] = useState<VncStatus>('connecting')
  const [busy, setBusy] = useState(false)
  const [full, toggleFull] = useFullScreen()

  const refresh = useCallback(
    async (client: ApiClient, bot: Bot) => {
      const display = await client.call('getBotDisplay', { params: { workspaceId, botId: bot.id } })
      setLoad({ kind: 'ready', client, bot, display })
    },
    [workspaceId],
  )

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const ctx = await window.milibot.getContext()
        const client = createApiClient(ctx.daemon)
        const settings = await client.call('getAppSettings', {})
        setLanguage(settings.language)
        setThemePreference(settings.theme)
        const bot = (await client.call('listBots', { params: { workspaceId } })).find((b) => b.id === botId)
        if (!bot) throw new Error('bot not found')
        if (!cancelled) await refresh(client, bot)
      } catch {
        if (!cancelled) setLoad({ kind: 'error' })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [workspaceId, botId, refresh])

  const ready = load.kind === 'ready' ? load : null
  useEffect(() => {
    if (!ready || loginMode) return
    const timer = setInterval(() => void refresh(ready.client, ready.bot).catch(() => undefined), REFRESH_MS)
    return () => clearInterval(timer)
  }, [ready, loginMode, refresh])

  useEffect(() => {
    if (ready) document.title = t('vmWindow.title', { name: ready.bot.name })
  }, [ready, t])

  const control = ready?.display.control ?? 'idle'
  const viewOnly = !loginMode && control !== 'user'
  const act = async (action: 'takeover' | 'release') => {
    if (!ready) return
    setBusy(true)
    try {
      await ready.client.call('controlBot', {
        params: { workspaceId, botId: ready.bot.id },
        body: { action },
      })
      await refresh(ready.client, ready.bot)
    } finally {
      setBusy(false)
    }
  }

  const badge = loginMode
    ? { text: t('vmWindow.yourControl'), tone: 'accent' as const }
    : { text: t(`panels.vm.control.${control}`), tone: CONTROL_TONE[control] }

  return (
    <div className="flex h-full flex-col bg-screen">
      <header
        className={cn(
          'drag-region flex h-10 shrink-0 items-center gap-2.5 border-b border-border bg-surface pr-2.5 win:pr-caption-2.5',
          full ? 'pl-3' : 'pl-3 mac:pl-[78px]',
        )}
      >
        <span className="truncate text-base font-semibold text-fg">
          {ready ? t('vmWindow.heading', { name: ready.bot.name }) : t('panels.vm.titleNoBot')}
        </span>
        {ready && (
          <span
            className={`flex h-[19px] shrink-0 items-center gap-[5px] rounded-full px-2 text-xs font-semibold ${TONE_SOFT[badge.tone]}`}
          >
            <StatusDot tone={badge.tone} />
            {badge.text}
          </span>
        )}
        {/* ⌘V paste from the host clipboard is macOS only: the hint is empty on Linux and Windows. */}
        {!viewOnly && t('vmWindow.pasteHint') && (
          <span className="truncate text-xs text-fg-muted">{t('vmWindow.pasteHint')}</span>
        )}
        <span className="flex-1" />
        <div className="no-drag flex items-center gap-1.5">
          {ready && !loginMode && control === 'user' && (
            <Button size="sm" disabled={busy} onClick={() => void act('release')}>
              <Undo2 size={12} />
              {t('panels.vm.release')}
            </Button>
          )}
          <Tooltip content={full ? t('vmWindow.exitFullScreen') : t('vmWindow.fullScreen')}>
            <button
              type="button"
              aria-label={full ? t('vmWindow.exitFullScreen') : t('vmWindow.fullScreen')}
              onClick={toggleFull}
              className="focus-ring flex size-7 items-center justify-center rounded-md text-fg-secondary hover:bg-surface-3 hover:text-fg"
            >
              {full ? <Minimize size={14} /> : <Maximize size={14} />}
            </button>
          </Tooltip>
          <Tooltip content={t('common.close')}>
            <button
              type="button"
              aria-label={t('common.close')}
              onClick={() => window.close()}
              className="focus-ring flex size-7 items-center justify-center rounded-md text-fg-secondary hover:bg-surface-3 hover:text-fg"
            >
              <X size={15} />
            </button>
          </Tooltip>
        </div>
      </header>
      <div className="relative min-h-0 flex-1">
        {ready && (
          <VncViewer
            workspaceId={workspaceId}
            botId={ready.bot.id}
            viewOnly={viewOnly}
            hostPaste
            label={t('panels.vm.screenLabel', { name: ready.bot.name })}
            onStatus={setStatus}
          />
        )}
        {ready && !loginMode && control !== 'user' && status === 'connected' && (
          <TakeOverOverlay busy={busy} onTakeOver={() => void act('takeover')} />
        )}
        {(load.kind === 'loading' || (ready && status !== 'connected')) && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center gap-2 text-sm text-screen-fg-secondary">
            <Spinner size={15} />
            {status === 'disconnected' ? t('panels.vm.reconnecting') : t('panels.vm.connecting')}
          </div>
        )}
        {load.kind === 'error' && (
          <div className="absolute inset-0 flex items-center justify-center text-sm text-screen-fg-secondary">
            {t('vmWindow.unavailable')}
          </div>
        )}
      </div>
    </div>
  )
}
