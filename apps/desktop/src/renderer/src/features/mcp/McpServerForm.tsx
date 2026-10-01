import type { CreateMcpServerBody, McpServer, McpTestResult, McpTransport } from '@milibot/shared'
import { Check, KeyRound, X, Zap } from 'lucide-react'
import { useId, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { joinCommandLine, splitCommandLine } from '@/features/mcp/lib/mcp'
import { useAppStore } from '@/features/workspace/store'
import { useWorkspaceId } from '@/features/workspace/use-workspace-id'
import { errorMessage } from '@/lib/errors'
import { botOptions as sortedBotOptions } from '@/lib/select-options'
import { Button } from '@/ui/Button'
import { MultiSelect } from '@/ui/MultiSelect'
import { Segmented } from '@/ui/Segmented'
import { Tag } from '@/ui/Tag'
import { Tooltip } from '@/ui/Tooltip'

import { type Pair, pair, pairsOf, toInput } from './lib/pairs'
import { fieldInput, PairsEditor } from './PairsEditor'
import { useMcpStore } from './store'

type TestState = { status: 'idle' } | { status: 'testing' } | ({ status: 'done' } & McpTestResult)

const MAX_TOOL_CHIPS = 8

export function McpServerForm({ server, onClose }: { server?: McpServer; onClose: () => void }) {
  const { t } = useTranslation()
  const baseId = useId()
  const workspaceId = useWorkspaceId()
  const bots = useAppStore((s) => s.bots)
  const createServer = useMcpStore((s) => s.create)
  const updateServer = useMcpStore((s) => s.update)
  const testDraft = useMcpStore((s) => s.testDraft)
  const [transport, setTransport] = useState<McpTransport>(server?.transport ?? 'stdio_vm')
  const [name, setName] = useState(server?.name ?? '')
  const [commandLine, setCommandLine] = useState(
    server?.transport === 'stdio_vm' ? joinCommandLine([server.command ?? '', ...server.args]) : '',
  )
  const [url, setUrl] = useState(server?.url ?? '')
  const [env, setEnv] = useState<Pair[]>(() => (server ? pairsOf(server, 'env') : [pair()]))
  const [headers, setHeaders] = useState<Pair[]>(() =>
    server?.headers.length ? pairsOf(server, 'headers') : [pair()],
  )
  const [allowedBots, setAllowedBots] = useState<'all' | string[]>(server?.allowedBots ?? 'all')
  const [test, setTest] = useState<TestState>({ status: 'idle' })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const testRun = useRef(0)

  const botOptions = useMemo(() => sortedBotOptions(bots), [bots])

  const body = (): CreateMcpServerBody | null => {
    const words = splitCommandLine(commandLine)
    if (!name.trim()) return null
    if (transport === 'stdio_vm' && !words[0]) return null
    if (transport === 'http' && !url.trim()) return null
    return transport === 'stdio_vm'
      ? {
          name: name.trim(),
          transport,
          command: words[0] ?? '',
          args: words.slice(1),
          env: toInput(env),
          allowedBots,
        }
      : { name: name.trim(), transport, url: url.trim(), headers: toInput(headers), allowedBots }
  }

  const requiredMessage = () =>
    t('mcp.form.required', {
      field: (transport === 'http' ? t('mcp.form.url') : t('mcp.form.command')).toLowerCase(),
    })

  const runTest = async () => {
    const config = body()
    if (!config) return setError(requiredMessage())
    setError(null)
    const run = ++testRun.current
    setTest({ status: 'testing' })
    try {
      const result = await testDraft(workspaceId, config, server?.id)
      if (run === testRun.current) setTest({ status: 'done', ...result })
    } catch (err) {
      if (run === testRun.current)
        setTest({ status: 'done', ok: false, tools: [], error: errorMessage(err), latencyMs: null })
    }
  }

  const save = async () => {
    const config = body()
    if (!config) return setError(requiredMessage())
    setError(null)
    setSaving(true)
    try {
      if (server) {
        const { name: newName, allowedBots: bots, ...connection } = config
        const before = JSON.stringify({
          transport: server.transport,
          command: server.command,
          args: server.args,
          url: server.url,
          env: toInput(pairsOf(server, 'env')),
          headers: toInput(pairsOf(server, 'headers')),
        })
        const after = JSON.stringify({
          transport: connection.transport,
          command: connection.command ?? null,
          args: connection.args ?? [],
          url: connection.url ?? null,
          env: connection.env ?? [],
          headers: connection.headers ?? [],
        })
        const connectionChanged = before !== after
        await updateServer(workspaceId, server.id, {
          name: newName,
          allowedBots: bots,
          ...(connectionChanged
            ? {
                transport: connection.transport,
                command: connection.command ?? null,
                args: connection.args ?? [],
                url: connection.url ?? null,
                env: connection.env ?? [],
                headers: connection.headers ?? [],
              }
            : {}),
        })
      } else {
        await createServer(workspaceId, config)
      }
      onClose()
    } catch (err) {
      setError(t('mcp.form.saveFailed', { error: errorMessage(err) }))
    } finally {
      setSaving(false)
    }
  }

  const title = server ? t('mcp.form.editTitle', { name: server.name }) : t('mcp.form.newTitle')
  const fieldLabel = 'text-xs text-fg-secondary'

  return (
    <section
      aria-label={title}
      className="flex flex-col gap-2.5 rounded-xl border border-accent bg-surface-2 p-3.5"
      onKeyDown={(e) => {
        if (e.key === 'Escape' && !document.querySelector('[data-menu]')) {
          e.preventDefault()
          onClose()
        }
      }}
    >
      <div className="flex items-center justify-between">
        <h2 className="text-md font-semibold text-fg">{title}</h2>
        <button
          type="button"
          aria-label={t('common.close')}
          onClick={onClose}
          className="focus-ring flex size-6 items-center justify-center rounded text-fg-muted hover:bg-surface-3 hover:text-fg"
        >
          <X size={14} />
        </button>
      </div>
      <Segmented
        size="sm"
        className="w-fit"
        label={t('mcp.form.kind')}
        value={transport}
        options={[
          { value: 'stdio_vm', label: t('mcp.form.stdio') },
          { value: 'http', label: t('mcp.form.http') },
        ]}
        onChange={(value) => {
          setTransport(value)
          setTest({ status: 'idle' })
        }}
      />
      <div className="flex gap-2.5">
        <div className="flex w-[180px] shrink-0 flex-col gap-1">
          <label htmlFor={`${baseId}-name`} className={fieldLabel}>
            {t('mcp.form.name')}
          </label>
          <input
            id={`${baseId}-name`}
            className={fieldInput}
            value={name}
            maxLength={64}
            placeholder={t('mcp.form.namePlaceholder')}
            onChange={(e) => setName(e.target.value)}
            autoFocus={!server}
          />
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <label htmlFor={`${baseId}-target`} className={fieldLabel}>
            {transport === 'stdio_vm' ? t('mcp.form.command') : t('mcp.form.url')}
          </label>
          {transport === 'stdio_vm' ? (
            <input
              id={`${baseId}-target`}
              className={`${fieldInput} font-mono`}
              value={commandLine}
              spellCheck={false}
              placeholder={t('mcp.form.commandPlaceholder')}
              onChange={(e) => setCommandLine(e.target.value)}
            />
          ) : (
            <input
              id={`${baseId}-target`}
              className={`${fieldInput} font-mono`}
              value={url}
              type="url"
              spellCheck={false}
              placeholder={t('mcp.form.urlPlaceholder')}
              onChange={(e) => setUrl(e.target.value)}
            />
          )}
        </div>
      </div>
      <div className="flex gap-2.5">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <label htmlFor={`${baseId}-pairs`} className={fieldLabel}>
            {transport === 'stdio_vm' ? t('mcp.form.env') : t('mcp.form.headers')}
          </label>
          {transport === 'stdio_vm' ? (
            <PairsEditor
              id={`${baseId}-pairs`}
              pairs={env}
              onChange={setEnv}
              namePlaceholder={t('mcp.form.envNamePlaceholder')}
              addLabel={t('mcp.form.addEnv')}
            />
          ) : (
            <PairsEditor
              id={`${baseId}-pairs`}
              pairs={headers}
              onChange={setHeaders}
              namePlaceholder={t('mcp.form.headerNamePlaceholder')}
              addLabel={t('mcp.form.addHeader')}
            />
          )}
        </div>
        <div className="flex w-[220px] shrink-0 flex-col gap-1">
          <label htmlFor={`${baseId}-bots`} className={fieldLabel}>
            {t('mcp.form.bots')}
          </label>
          <MultiSelect
            id={`${baseId}-bots`}
            className="!h-[30px] !text-sm"
            value={allowedBots}
            options={botOptions}
            onChange={setAllowedBots}
            label={t('mcp.form.bots')}
            allLabel={t('mcp.allBots')}
            placeholder={t('mcp.form.botsPlaceholder')}
          />
        </div>
      </div>
      <div className="flex min-h-[27px] flex-wrap items-center gap-2">
        <Button size="sm" onClick={() => void runTest()} disabled={test.status === 'testing'}>
          <Zap size={12} />
          {test.status === 'testing' ? t('mcp.form.testing') : t('mcp.form.test')}
        </Button>
        {test.status === 'done' &&
          (test.ok ? (
            <>
              <Tag tone="success" icon={<Check size={10} aria-hidden />}>
                {t('mcp.form.testOk', { count: test.tools.length })}
              </Tag>
              {test.tools.slice(0, MAX_TOOL_CHIPS).map((tool) => (
                <Tooltip key={tool.name} content={tool.description || null} maxWidth={320}>
                  <span>
                    <Tag>{tool.name}</Tag>
                  </span>
                </Tooltip>
              ))}
              {test.tools.length > MAX_TOOL_CHIPS && (
                <Tag>{t('mcp.form.moreTools', { count: test.tools.length - MAX_TOOL_CHIPS })}</Tag>
              )}
            </>
          ) : test.authRequired ? (
            <span className="flex min-w-0 max-w-[560px] items-center gap-1.5 text-sm text-fg-secondary">
              <KeyRound size={12} className="shrink-0 text-accent" aria-hidden />
              <span className="truncate">{t('mcp.form.oauthDetected')}</span>
            </span>
          ) : (
            <Tooltip content={test.error} maxWidth={420}>
              <span className="min-w-0 max-w-[560px] truncate text-sm text-danger">
                {t('mcp.form.testFailed', { error: (test.error ?? '').split('\n')[0] })}
              </span>
            </Tooltip>
          ))}
        <span className="flex-1" />
        {error && <span className="text-sm text-danger">{error}</span>}
        <Button size="sm" variant="primary" onClick={() => void save()} disabled={saving}>
          {saving ? t('mcp.form.saving') : t('common.save')}
        </Button>
      </div>
    </section>
  )
}
