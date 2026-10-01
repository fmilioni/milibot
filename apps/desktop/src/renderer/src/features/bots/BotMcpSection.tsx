import type { Bot, BotMcpServer, McpServer } from '@milibot/shared'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { ServerIcon } from '@/features/mcp/ServerIcon'
import { NO_MCP_SERVERS, useMcpStore } from '@/features/mcp/store'
import { useAppStore } from '@/features/workspace/store'
import { useWorkspaceId } from '@/features/workspace/use-workspace-id'
import { cn } from '@/lib/cn'
import { Tooltip } from '@/ui/Tooltip'

export function SmallSwitch({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean
  onChange: (checked: boolean) => void
  label: string
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        'focus-ring relative h-4 w-7 shrink-0 rounded-full p-0.5 transition-colors disabled:opacity-50',
        checked ? 'bg-accent' : 'bg-surface-3',
      )}
    >
      <span
        className={cn(
          'block size-3 rounded-full bg-white shadow-sm transition-transform',
          checked && 'translate-x-3',
        )}
      />
    </button>
  )
}

function ServerItem({
  server,
  prefs,
  onChange,
  last,
}: {
  server: McpServer
  prefs: BotMcpServer
  onChange: (body: { enabled?: boolean; disabledTools?: string[] }) => void
  last: boolean
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const disabled = new Set(prefs.disabledTools)
  const total = server.tools.length
  const enabledCount = server.tools.filter((tool) => !disabled.has(tool.name)).length
  const on = prefs.enabled && server.enabled
  const count =
    total === 0
      ? null
      : enabledCount === total
        ? t('panels.bot.mcp.tools', { count: total })
        : t('panels.bot.mcp.count', { enabled: enabledCount, total })
  const tokens = server.tools
    .filter((tool) => !disabled.has(tool.name))
    .reduce((sum, tool) => sum + tool.tokens, 0)
  const listId = `mcp-tools-${server.id}`

  return (
    <div className={last ? '' : 'border-b border-border'}>
      <div className="flex items-center gap-2.5 px-3 py-2.5">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={listId}
          aria-label={t('panels.bot.mcp.expand', { name: server.name })}
          onClick={() => setOpen(!open)}
          className="focus-ring flex min-w-0 flex-1 items-center gap-2.5 rounded text-left"
        >
          {open ? (
            <ChevronDown size={12} className="shrink-0 text-fg-muted" aria-hidden />
          ) : (
            <ChevronRight size={12} className="shrink-0 text-fg-muted" aria-hidden />
          )}
          <span className="shrink-0 text-fg">
            <ServerIcon server={server} size={14} />
          </span>
          <span className="truncate text-base font-medium text-fg">{server.name}</span>
          <Tooltip content={on && tokens > 0 ? t('panels.bot.mcp.tokens', { count: tokens }) : null}>
            <span className="truncate text-xs text-fg-muted">
              {server.enabled ? count : t('panels.bot.mcp.serverOff')}
            </span>
          </Tooltip>
        </button>
        <SmallSwitch
          checked={on}
          disabled={!server.enabled}
          label={t('panels.bot.mcp.useServer', { name: server.name })}
          onChange={(enabled) => onChange({ enabled })}
        />
      </div>
      {open && (
        <ul id={listId} className="flex flex-col gap-1.5 pr-3 pb-2.5 pl-11">
          {total === 0 && <li className="text-xs text-fg-muted">{t('panels.bot.mcp.noTools')}</li>}
          {server.tools.map((tool) => (
            <li key={tool.name} className="flex min-h-4 items-center gap-2">
              <span className="shrink-0 font-mono text-xs text-fg">{tool.name}</span>
              <Tooltip content={tool.description || null} maxWidth={360}>
                <span className="min-w-0 flex-1 truncate text-xs text-fg-muted">{tool.description}</span>
              </Tooltip>
              <SmallSwitch
                checked={!disabled.has(tool.name)}
                disabled={!on}
                label={t('panels.bot.mcp.useTool', { name: tool.name })}
                onChange={(value) => {
                  const next = new Set(disabled)
                  if (value) next.delete(tool.name)
                  else next.add(tool.name)
                  onChange({ disabledTools: [...next] })
                }}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

export function BotMcpSection({ bot }: { bot: Bot }) {
  const { t } = useTranslation()
  const workspaceId = useWorkspaceId()
  const openSettings = useAppStore((s) => s.openSettings)
  const showToast = useAppStore((s) => s.showToast)
  const servers = useMcpStore((s) => (s.workspaceId === workspaceId ? s.servers : NO_MCP_SERVERS))
  const prefs = useMcpStore((s) => (s.workspaceId === workspaceId ? s.botServers[bot.id] : undefined))
  const loadBot = useMcpStore((s) => s.loadBot)
  const updateBotServer = useMcpStore((s) => s.updateBotServer)
  const serverIds = servers.map((s) => `${s.id}:${JSON.stringify(s.allowedBots)}`).join(',')

  useEffect(() => {
    void loadBot(workspaceId, bot.id).catch(() => undefined)
  }, [loadBot, workspaceId, bot.id, serverIds])

  const rows = (prefs ?? []).flatMap((p) => {
    const server = servers.find((s) => s.id === p.serverId)
    return server ? [{ server, prefs: p }] : []
  })

  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-fg-secondary">{t('panels.bot.mcp.title')}</h3>
        <button
          type="button"
          onClick={() => openSettings('mcp')}
          className="focus-ring rounded text-sm text-accent hover:underline"
        >
          {t('panels.bot.mcp.manage')}
        </button>
      </div>
      {rows.length > 0 ? (
        <div className="flex flex-col rounded-[10px] border border-border bg-surface-2">
          {rows.map(({ server, prefs: p }, index) => (
            <ServerItem
              key={server.id}
              server={server}
              prefs={p}
              last={index === rows.length - 1}
              onChange={(body) =>
                void updateBotServer(workspaceId, bot.id, server.id, body).catch(() => showToast('error'))
              }
            />
          ))}
        </div>
      ) : (
        prefs && (
          <div className="rounded-lg border border-dashed border-border px-3 py-2.5 text-sm text-fg-muted">
            {t('panels.bot.mcp.empty')}
          </div>
        )
      )}
      <span className="text-xs leading-[14px] text-fg-muted">{t('panels.bot.mcp.hint')}</span>
    </section>
  )
}
