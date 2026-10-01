import type { McpConnectionStatus, McpServer } from '@milibot/shared'
import { Info, KeyRound, LogOut, Pencil, Plus, Trash2, Zap } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { allowedBotNames, serverDetail } from '@/features/mcp/lib/mcp'
import { Notice, SettingsPage } from '@/features/settings/SettingsLayout'
import { toastOnError, useAppStore } from '@/features/workspace/store'
import { useWorkspaceId } from '@/features/workspace/use-workspace-id'
import { cn } from '@/lib/cn'
import type { Tone } from '@/lib/tone'
import { Button } from '@/ui/Button'
import { InlineConfirm } from '@/ui/Confirm'
import type { MenuEntry } from '@/ui/Menu'
import { MoreMenu } from '@/ui/MoreMenu'
import { Switch } from '@/ui/Switch'
import { StatusDot, Tag } from '@/ui/Tag'
import { Tooltip } from '@/ui/Tooltip'

import { McpServerForm } from './McpServerForm'
import { ServerIcon } from './ServerIcon'
import { NO_MCP_SERVERS, useMcpStore } from './store'

const STATUS_TONE: Record<McpConnectionStatus, Tone> = {
  connected: 'success',
  error: 'danger',
  connecting: 'warning',
  needs_auth: 'warning',
  disabled: 'muted',
  idle: 'muted',
}

function StateLine({ server }: { server: McpServer }) {
  const { t } = useTranslation()
  const { status, error } = server.state
  const text =
    status === 'error'
      ? t('mcp.state.error', { error: (error ?? '').split('\n')[0] })
      : t(`mcp.state.${status}`)
  return (
    <Tooltip content={status === 'error' ? error : null} maxWidth={420}>
      <span className="flex min-w-0 items-center gap-[5px]">
        <StatusDot tone={STATUS_TONE[status]} pulse={status === 'connecting'} />
        <span className={cn('truncate text-xs', status === 'error' ? 'text-danger' : 'text-fg-muted')}>
          {text}
        </span>
      </span>
    </Tooltip>
  )
}

/** Sign-in line of a remote server that uses OAuth: who is connected, or the button to connect. */
function OAuthLine({ server }: { server: McpServer }) {
  const { t } = useTranslation()
  const workspaceId = useWorkspaceId()
  const connectOAuth = useMcpStore((s) => s.connectOAuth)
  const cancelOAuth = useMcpStore((s) => s.cancelOAuth)
  const oauth = server.oauth
  if (!oauth) return null
  const run = (action: Promise<void>) => void toastOnError(action)
  return (
    <div className="flex items-center gap-3 border-t border-border px-3.5 py-2.5">
      <KeyRound
        size={14}
        className={cn('shrink-0', oauth.connected ? 'text-success' : 'text-fg-muted')}
        aria-hidden
      />
      <span className="min-w-0 flex-1 truncate text-sm text-fg-secondary">
        {oauth.authorizing
          ? t('mcp.oauth.authorizing')
          : oauth.connected
            ? oauth.account
              ? t('mcp.oauth.connectedAs', { account: oauth.account })
              : t('mcp.oauth.connected')
            : oauth.connectedAt
              ? t('mcp.oauth.expired')
              : t('mcp.oauth.needed')}
      </span>
      {oauth.authorizing ? (
        <>
          <Button size="sm" variant="ghost" onClick={() => run(cancelOAuth(workspaceId, server.id))}>
            {t('common.cancel')}
          </Button>
          <Button size="sm" variant="outline" onClick={() => run(connectOAuth(workspaceId, server.id))}>
            {t('mcp.oauth.openAgain')}
          </Button>
        </>
      ) : (
        !oauth.connected && (
          <Button
            size="sm"
            variant="primary"
            disabled={!server.enabled}
            onClick={() => run(connectOAuth(workspaceId, server.id))}
          >
            {oauth.connectedAt ? t('mcp.oauth.reconnect') : t('mcp.oauth.connect')}
          </Button>
        )
      )}
    </div>
  )
}

function ServerRow({ server, onEdit }: { server: McpServer; onEdit: () => void }) {
  const { t } = useTranslation()
  const workspaceId = useWorkspaceId()
  const bots = useAppStore((s) => s.bots)
  const update = useMcpStore((s) => s.update)
  const remove = useMcpStore((s) => s.remove)
  const test = useMcpStore((s) => s.test)
  const disconnectOAuth = useMcpStore((s) => s.disconnectOAuth)
  const [confirming, setConfirming] = useState(false)
  const users = allowedBotNames(server.allowedBots, bots)
  const tools = server.tools.length

  const entries: MenuEntry[] = [
    { key: 'edit', label: t('mcp.edit'), icon: <Pencil size={14} />, onSelect: onEdit },
    {
      key: 'test',
      label: t('mcp.test'),
      icon: <Zap size={14} />,
      disabled: !server.enabled,
      onSelect: () => void toastOnError(test(workspaceId, server.id)),
    },
    ...(server.oauth?.connected
      ? [
          {
            key: 'disconnect',
            label: t('mcp.oauth.disconnect'),
            icon: <LogOut size={14} />,
            onSelect: () => void toastOnError(disconnectOAuth(workspaceId, server.id)),
          },
        ]
      : []),
    { type: 'separator', key: 'sep' },
    {
      key: 'delete',
      label: t('mcp.delete'),
      icon: <Trash2 size={14} />,
      danger: true,
      onSelect: () => setConfirming(true),
    },
  ]

  return (
    <li className="flex flex-col rounded-xl border border-border bg-surface-2">
      <div className="flex items-center gap-3 px-3.5 py-3">
        <span className="flex size-[34px] shrink-0 items-center justify-center rounded-[9px] bg-surface-3 text-fg">
          <ServerIcon server={server} />
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex min-w-0 items-center gap-2">
            <span className="truncate text-md font-semibold text-fg">{server.name}</span>
            <Tag>{t(`mcp.transport.${server.transport}`)}</Tag>
            <StateLine server={server} />
          </div>
          <span className="selectable truncate font-mono text-xs text-fg-muted">{serverDetail(server)}</span>
          <div className="flex min-w-0 flex-wrap items-center gap-1.5 text-xs text-fg-secondary">
            <span>
              {tools > 0 ? t('mcp.tools', { count: tools }) : t('mcp.noToolsYet')} · {t('mcp.usedBy')}
            </span>
            {users === 'all' ? (
              <Tag>{t('mcp.allBots')}</Tag>
            ) : users.length === 0 ? (
              <span className="text-fg-muted">{t('mcp.noBots')}</span>
            ) : (
              users.map((name) => <Tag key={name}>{name}</Tag>)
            )}
          </div>
        </div>
        <Switch
          checked={server.enabled}
          label={t('mcp.enable', { name: server.name })}
          onChange={(enabled) => void toastOnError(update(workspaceId, server.id, { enabled }))}
        />
        <MoreMenu
          label={t('mcp.more', { name: server.name })}
          entries={entries}
          width={180}
          menuLabel={server.name}
        />
      </div>
      <OAuthLine server={server} />
      {confirming && (
        <div className="px-3.5 pb-2.5">
          <InlineConfirm
            message={t('mcp.deleteConfirm', { name: server.name })}
            confirmLabel={t('mcp.delete')}
            onCancel={() => setConfirming(false)}
            onConfirm={() => void toastOnError(remove(workspaceId, server.id))}
          />
        </div>
      )}
    </li>
  )
}

export function McpSettings() {
  const { t } = useTranslation()
  const workspaceId = useWorkspaceId()
  const servers = useMcpStore((s) => (s.workspaceId === workspaceId ? s.servers : NO_MCP_SERVERS))
  const loading = useMcpStore((s) => s.loading)
  const load = useMcpStore((s) => s.load)
  const [form, setForm] = useState<{ serverId: string | null } | null>(null)

  useEffect(() => {
    void load(workspaceId).catch(() => undefined)
  }, [load, workspaceId])

  const editing = form?.serverId ? servers.find((s) => s.id === form.serverId) : undefined

  return (
    <SettingsPage
      title={t('mcp.title')}
      subtitle={t('mcp.subtitle')}
      actions={
        <Button variant="primary" onClick={() => setForm({ serverId: null })}>
          <Plus size={13} />
          {t('mcp.add')}
        </Button>
      }
    >
      {servers.length > 0 ? (
        <ul className="flex flex-col gap-3.5">
          {servers.map((server) =>
            form?.serverId === server.id && editing ? (
              <li key={server.id}>
                <McpServerForm key={server.id} server={editing} onClose={() => setForm(null)} />
              </li>
            ) : (
              <ServerRow key={server.id} server={server} onEdit={() => setForm({ serverId: server.id })} />
            ),
          )}
        </ul>
      ) : (
        !form && (
          <div className="rounded-xl border border-dashed border-border px-4 py-6 text-center text-base text-fg-muted">
            {loading ? t('mcp.loading') : t('mcp.empty')}
          </div>
        )
      )}
      {form && form.serverId === null && <McpServerForm onClose={() => setForm(null)} />}
      <Notice icon={<Info size={14} />}>{t('mcp.note')}</Notice>
    </SettingsPage>
  )
}
