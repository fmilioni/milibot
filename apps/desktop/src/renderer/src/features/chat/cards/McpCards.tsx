import { type McpSignInPayload, secretRefRegex } from '@milibot/shared'
import { KeyRound, Plug } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { cn } from '@/lib/cn'
import { Button } from '@/ui/Button'
import { LinkifiedText } from '@/ui/LinkifiedText'

interface KeyValue {
  name: string
  value?: string
}

/** The `details` param of an `mcp_*` confirmation (JSON written by the daemon's `McpAdmin`). */
interface McpDetails {
  name?: string
  transport?: 'http' | 'stdio_vm'
  target?: string
  headers?: KeyValue[]
  env?: KeyValue[]
  bots?: string[] | 'all'
  enabled?: boolean
}

function parseDetails(json: string): McpDetails | null {
  try {
    const value: unknown = JSON.parse(json)
    return value && typeof value === 'object' ? (value as McpDetails) : null
  } catch {
    return null
  }
}

const isKeyValue = (item: unknown): item is KeyValue =>
  !!item && typeof item === 'object' && typeof (item as KeyValue).name === 'string'

/** What an MCP confirmation card asks the user to approve; secret references show their names, never values. */
export function McpChangeDetails({ details }: { details: string }) {
  const { t } = useTranslation()
  const parsed = parseDetails(details)
  if (!parsed) return null
  const shownValue = (value: string | undefined) =>
    value === undefined
      ? t('chat.confirmation.mcp.keep')
      : value.replace(
          secretRefRegex(),
          (_, name: string) => `•••• (${t('chat.confirmation.mcp.secret', { name })})`,
        )
  const rows: Array<[string, string]> = []
  if (parsed.name) rows.push([t('chat.confirmation.mcp.name'), parsed.name])
  if (parsed.target)
    rows.push([
      t(parsed.transport === 'stdio_vm' ? 'chat.confirmation.mcp.command' : 'chat.confirmation.mcp.remote'),
      parsed.target,
    ])
  for (const key of ['headers', 'env'] as const) {
    const items = Array.isArray(parsed[key]) ? parsed[key].filter(isKeyValue) : []
    if (items.length)
      rows.push([
        t(`chat.confirmation.mcp.${key}`),
        items.map((item) => `${item.name}: ${shownValue(item.value)}`).join('\n'),
      ])
  }
  if (parsed.bots)
    rows.push([
      t('chat.confirmation.mcp.bots'),
      parsed.bots === 'all' ? t('chat.confirmation.mcp.allBots') : parsed.bots.join(', '),
    ])
  if (parsed.enabled !== undefined)
    rows.push([
      t('chat.confirmation.mcp.enabled'),
      t(parsed.enabled ? 'chat.confirmation.mcp.on' : 'chat.confirmation.mcp.off'),
    ])
  if (rows.length === 0) return null
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 rounded-lg bg-surface-3 px-3 py-2 text-sm">
      {rows.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="text-fg-muted">{label}</dt>
          <dd className="min-w-0 font-mono break-all whitespace-pre-line text-fg-secondary">{value}</dd>
        </div>
      ))}
    </dl>
  )
}

/** The `details` param of a `bot_mcp` confirmation. */
interface BotMcpDetailsJson {
  changes?: Array<{ server: string; on: boolean; tools: string[]; allow: boolean }>
}

const SHOWN_TOOLS = 8

/** What a change of a bot's MCP servers asks to approve: each switch and the tools the server brings. */
export function BotMcpDetails({ details, botName }: { details: string; botName: string }) {
  const { t } = useTranslation()
  let parsed: BotMcpDetailsJson | null = null
  try {
    parsed = JSON.parse(details) as BotMcpDetailsJson
  } catch {
    return null
  }
  if (!Array.isArray(parsed?.changes) || parsed.changes.length === 0) return null
  return (
    <ul className="flex flex-col gap-2 rounded-lg bg-surface-3 px-3 py-2 text-sm">
      {parsed.changes.map((change) => {
        const tools = Array.isArray(change.tools) ? change.tools : []
        const names = tools.slice(0, SHOWN_TOOLS).join(', ') + (tools.length > SHOWN_TOOLS ? ', …' : '')
        return (
          <li key={change.server} className="flex flex-col gap-0.5">
            <span className="text-fg">
              <span className="text-fg-muted">
                {t(change.on ? 'chat.confirmation.mcp.turnOn' : 'chat.confirmation.mcp.turnOff')}
              </span>{' '}
              <span className="font-semibold">{change.server}</span>
            </span>
            <span className="break-words text-fg-secondary">
              {tools.length
                ? t('chat.confirmation.mcp.tools', { count: tools.length, names })
                : t('chat.confirmation.mcp.noTools')}
            </span>
            {change.allow && (
              <span className="text-warning">{t('chat.confirmation.mcp.allow', { botName })}</span>
            )}
          </li>
        )
      })}
    </ul>
  )
}

const STATUS_CLASS: Record<McpSignInPayload['status'], string> = {
  pending: 'bg-accent-soft text-accent',
  connected: 'bg-success-soft text-success',
  failed: 'bg-danger-tint text-danger',
  expired: 'bg-surface-3 text-fg-muted',
  cancelled: 'bg-surface-3 text-fg-muted',
}

/** A bot's OAuth sign-in of an MCP server: the link opens in the system browser, which redirects to the daemon. */
export function McpSignInCard({ payload }: { payload: McpSignInPayload }) {
  const { t } = useTranslation()
  const url = /^https?:\/\//.test(payload.authorizationUrl) ? payload.authorizationUrl : null
  const pending = payload.status === 'pending'
  return (
    <div className="flex flex-col gap-2 rounded-[10px] border border-border bg-surface-2 p-3.5">
      <div className="flex items-center gap-2">
        <Plug size={15} className="shrink-0 text-fg-muted" />
        <span className="min-w-0 flex-1 truncate text-base font-semibold text-fg">
          {t('chat.mcpSignIn.title', { serverName: payload.serverName })}
        </span>
        <span
          className={cn(
            'shrink-0 rounded-full px-2 py-0.5 text-xs font-semibold',
            STATUS_CLASS[payload.status],
          )}
        >
          {t(`chat.mcpSignIn.status.${payload.status}`)}
        </span>
      </div>
      {pending && <p className="text-sm text-fg-secondary">{t('chat.mcpSignIn.hint')}</p>}
      {payload.status === 'connected' && payload.account && (
        <p className="text-sm text-fg-secondary">
          {t('chat.mcpSignIn.account', { account: payload.account })}
        </p>
      )}
      {payload.status === 'failed' && payload.error && (
        <p className="text-sm break-words text-danger">
          <LinkifiedText text={payload.error} />
        </p>
      )}
      {pending && url && (
        <div>
          <Button size="sm" variant="primary" onClick={() => void window.milibot.openExternal(url)}>
            <KeyRound size={13} />
            {t('chat.mcpSignIn.open')}
          </Button>
        </div>
      )}
    </div>
  )
}
