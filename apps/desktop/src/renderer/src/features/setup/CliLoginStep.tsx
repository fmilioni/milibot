import { type Bot, CLI_ENGINE_INFO, type CliEngine, type VmInfo } from '@milibot/shared'
import { AlertTriangle, Maximize2, RotateCw, SquareTerminal } from 'lucide-react'
import { useCallback, useEffect, useEffectEvent, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Notice } from '@/features/settings/SettingsLayout'
import { createLoginPoller, createLoginTerminalKeeper } from '@/features/setup/lib/setup'
import { type VncStatus, VncViewer } from '@/features/vm/VncViewer'
import { cliTextParams } from '@/lib/cli-engines'
import { cn } from '@/lib/cn'
import { apiErrorReason, isApiError } from '@/lib/errors'
import { Button } from '@/ui/Button'
import { Spinner } from '@/ui/Spinner'
import { TextInput } from '@/ui/TextInput'

import { cliLoginStatus, openLoginTerminal, signInWithApiKey, waitForBotScreen } from './api'

type TerminalState = 'opening' | 'open' | 'failed'

const vmNotRunning = (err: unknown) =>
  isApiError(err, 'conflict') &&
  (apiErrorReason(err) === 'vm_not_running' || err.message === 'VM_NOT_RUNNING')

export function CliLoginStep({
  engine,
  workspaceId,
  workspaceName,
  firstBot,
  vm,
  providerId,
  onDone,
  onChangeProviders,
}: {
  engine: CliEngine
  workspaceId: string
  workspaceName: string
  firstBot: Bot | undefined
  vm: VmInfo | null
  providerId: string | null
  onDone: () => Promise<void>
  /** Back to step 1, to use something other than a subscription. */
  onChangeProviders: () => Promise<void>
}) {
  const { t } = useTranslation()
  const params = cliTextParams(engine)
  const [terminal, setTerminal] = useState<TerminalState>('opening')
  const [vncReady, setVncReady] = useState(false)
  const [vncStatus, setVncStatus] = useState<VncStatus>('connecting')
  const [mode, setMode] = useState<'login' | 'key'>('login')
  const [apiKey, setApiKey] = useState('')
  const [saving, setSaving] = useState(false)
  const [keyError, setKeyError] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const [terminalClosed, setTerminalClosed] = useState(false)
  const [wrongAccount, setWrongAccount] = useState(false)
  const [reopening, setReopening] = useState(false)
  const running = vm?.state === 'running'
  const firstBotId = firstBot?.id ?? null
  const done = useEffectEvent(() => void onDone())

  // Each open (the VM coming up, another bot, a retry) starts from "opening".
  const openKey = running && firstBotId ? `${engine}:${firstBotId}:${attempt}` : null
  const [openedKey, setOpenedKey] = useState(openKey)
  if (openKey !== openedKey) {
    setOpenedKey(openKey)
    if (openKey) setTerminal('opening')
  }

  useEffect(() => {
    if (!running || !firstBotId) return
    let cancelled = false
    void (async () => {
      try {
        await waitForBotScreen(workspaceId, firstBotId)
        if (cancelled) return
        setVncReady(true)
        await openLoginTerminal(engine, workspaceId, firstBotId)
        if (!cancelled) setTerminal('open')
      } catch (err) {
        if (cancelled) return
        // The VM is still coming up: the effect runs again once it is running.
        if (vmNotRunning(err)) return
        setTerminal('failed')
      }
    })()
    return () => {
      cancelled = true
    }
  }, [engine, running, firstBotId, workspaceId, attempt])

  const openWindow = () => {
    if (!firstBot) return
    void window.milibot.openVmWindow({
      workspaceId,
      botId: firstBot.id,
      title: t('vmWindow.title', { name: firstBot.name }),
      mode: 'login',
    })
  }
  const closeWindow = () => {
    if (firstBotId) void window.milibot.closeVmWindow(workspaceId, firstBotId)
  }

  const terminalOpen = useEffectEvent(() => terminal === 'open')
  const reopenTerminal = useCallback(async () => {
    if (!firstBotId) return
    await openLoginTerminal(engine, workspaceId, firstBotId)
    setTerminalClosed(false)
  }, [engine, workspaceId, firstBotId])
  const keeperRef = useRef<ReturnType<typeof createLoginTerminalKeeper> | null>(null)

  useEffect(() => {
    if (!running || mode !== 'login') return
    const keeper = createLoginTerminalKeeper({ reopen: reopenTerminal })
    keeperRef.current = keeper
    const poller = createLoginPoller({
      check: () => cliLoginStatus(engine, workspaceId),
      onLoggedIn: () => {
        if (firstBotId) void window.milibot.closeVmWindow(workspaceId, firstBotId)
        done()
      },
      onStatus: (status) => {
        setWrongAccount(status.loggedInElsewhere)
        setTerminalClosed(status.terminalOpen === false)
        // Only a terminal this step managed to open is kept alive; a failed first open shows its own retry.
        if (terminalOpen()) keeper.observe(status)
      },
    })
    poller.start()
    return () => {
      poller.stop()
      keeperRef.current = null
    }
  }, [engine, running, mode, workspaceId, firstBotId, reopenTerminal])

  const reopenByUser = async () => {
    keeperRef.current?.reset()
    setReopening(true)
    try {
      await reopenTerminal()
      setTerminal('open')
      openWindow()
    } catch {
      setTerminal('failed')
    } finally {
      setReopening(false)
    }
  }

  const reopenButton = (
    <Button
      size="sm"
      disabled={!running || reopening || terminal === 'opening'}
      onClick={() => void reopenByUser()}
    >
      {reopening ? <Spinner size={12} /> : <SquareTerminal size={12} />}
      {t('setup.login.reopen')}
    </Button>
  )

  const [leaving, setLeaving] = useState(false)
  const changeProviders = async () => {
    setLeaving(true)
    closeWindow()
    try {
      await onChangeProviders()
    } finally {
      setLeaving(false)
    }
  }

  const saveKey = async () => {
    if (!providerId || !apiKey.trim()) return
    setSaving(true)
    setKeyError(false)
    try {
      await signInWithApiKey(workspaceId, providerId, apiKey.trim())
      closeWindow()
      await onDone()
    } catch {
      setKeyError(true)
    } finally {
      setSaving(false)
    }
  }

  if (mode === 'key') {
    return (
      <form
        className="flex flex-col gap-2.5 rounded-[10px] border border-border bg-surface-2 p-3.5"
        onSubmit={(e) => {
          e.preventDefault()
          void saveKey()
        }}
      >
        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-semibold text-fg">{t('setup.login.keyTitle', params)}</span>
          <span className="text-xs text-fg-secondary">{t('setup.login.keyHint', params)}</span>
          <TextInput
            data-autofocus
            autoFocus
            type="password"
            autoComplete="off"
            spellCheck={false}
            className="mt-1 font-mono text-sm"
            placeholder={CLI_ENGINE_INFO[engine].keyPlaceholder}
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
          />
        </label>
        {keyError && <p className="text-xs text-danger">{t('toast.error')}</p>}
        <div className="flex items-center justify-between">
          <button
            type="button"
            onClick={() => setMode('login')}
            className="focus-ring rounded text-sm text-accent hover:underline"
          >
            {t('setup.login.back')}
          </button>
          <Button type="submit" variant="primary" disabled={!apiKey.trim() || saving || !providerId}>
            {saving && <Spinner size={13} />}
            {t('setup.login.saveKey')}
          </Button>
        </div>
      </form>
    )
  }

  return (
    <div className="flex flex-col gap-2.5">
      <div className="overflow-hidden rounded-[10px] border border-border bg-screen-surface shadow-sm">
        <div className="flex h-[26px] items-center gap-1.5 bg-screen-surface-2 px-2.5">
          {[0, 1, 2].map((i) => (
            <span key={i} className="size-2 rounded-full bg-screen-border" aria-hidden />
          ))}
          <span className="ml-1.5 truncate font-mono text-xs text-screen-fg-secondary">
            {t('setup.login.windowTitle', {
              name: `milibot-${workspaceName.toLowerCase().replace(/\s+/g, '-')}`,
            })}
          </span>
        </div>
        <div className="group relative aspect-[1280/800] w-full">
          {vncReady && running && firstBot ? (
            <VncViewer
              workspaceId={workspaceId}
              botId={firstBot.id}
              viewOnly
              label={t('setup.login.screenLabel', params)}
              onStatus={setVncStatus}
            />
          ) : null}
          {terminal === 'open' && vncStatus === 'connected' && (
            <button
              type="button"
              onClick={openWindow}
              aria-label={t('vmWindow.open')}
              className="focus-ring absolute inset-0 flex cursor-pointer items-end justify-center pb-3"
            >
              <span className="flex items-center gap-1.5 rounded-md bg-screen/80 px-2.5 py-1 text-xs text-screen-fg opacity-0 transition-opacity group-hover:opacity-100 motion-reduce:transition-none">
                <Maximize2 size={11} />
                {t('setup.login.openHint')}
              </span>
            </button>
          )}
          {(!vncReady || vncStatus !== 'connected' || terminal === 'opening') && terminal !== 'failed' && (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center gap-2 text-sm text-screen-fg-secondary">
              <Spinner size={14} />
              {t('setup.login.opening')}
            </div>
          )}
          {terminal === 'failed' && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2.5 text-sm text-screen-fg-secondary">
              {t('setup.login.failed')}
              <Button size="sm" onClick={() => setAttempt((n) => n + 1)}>
                <RotateCw size={12} />
                {t('setup.login.retry')}
              </Button>
            </div>
          )}
        </div>
      </div>
      {wrongAccount && (
        <div role="alert">
          <Notice
            tone="warning"
            icon={<AlertTriangle size={14} className="text-warning" />}
            action={reopenButton}
          >
            {t('setup.login.wrongTerminal')}
          </Notice>
        </div>
      )}
      <div className="@container flex flex-col gap-2.5 px-0.5">
        <span className="flex items-center gap-2 text-sm text-fg-secondary" role="status">
          <Spinner size={13} className="text-accent" />
          {terminalClosed && terminal === 'open' ? t('setup.login.terminalClosed') : t('setup.login.waiting')}
        </span>
        <div className={cn('grid grid-cols-1 gap-2', !wrongAccount && '@[24rem]:grid-cols-2')}>
          {!wrongAccount && (
            <Button
              className="w-full justify-center whitespace-nowrap"
              disabled={!running || reopening || terminal === 'opening'}
              onClick={() => void reopenByUser()}
            >
              {reopening ? <Spinner size={13} /> : <SquareTerminal size={13} />}
              {t('setup.login.reopen')}
            </Button>
          )}
          <Button
            variant="primary"
            className="w-full justify-center whitespace-nowrap"
            disabled={terminal !== 'open'}
            onClick={openWindow}
          >
            <Maximize2 size={13} />
            {t('vmWindow.open')}
          </Button>
        </div>
        <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-1">
          {providerId && (
            <button
              type="button"
              onClick={() => setMode('key')}
              className="focus-ring rounded text-sm text-accent hover:underline"
            >
              {t('setup.login.useKey')}
            </button>
          )}
          <button
            type="button"
            disabled={leaving}
            onClick={() => void changeProviders()}
            className="focus-ring rounded text-sm text-accent hover:underline disabled:opacity-60"
          >
            {t('setup.login.changeProviders')}
          </button>
        </div>
      </div>
    </div>
  )
}
