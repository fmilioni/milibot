import { RefreshCw } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { describeConversation } from '@/features/chat/lib/conversation'
import { RightPanelHeader } from '@/features/workspace/RightPanelHeader'
import { useActiveConversation, useAppStore } from '@/features/workspace/store'
import { EmptyState } from '@/ui/EmptyState'
import { Segmented } from '@/ui/Segmented'
import { Spinner } from '@/ui/Spinner'
import { Tooltip } from '@/ui/Tooltip'

import { useConversationDebug } from './api'
import { CallsTab } from './CallsTab'
import { ContextTab } from './ContextTab'
import { CostsTab } from './CostsTab'
import type { DebugData } from './DebugParts'

type Tab = 'calls' | 'context' | 'costs'

/** Debug data of a conversation (another conversation's data is never shown while this one loads). */
function useDebugData(conversationId: string | null) {
  const workspaceId = useAppStore((s) => s.workspaceId)
  const query = useConversationDebug(workspaceId, conversationId)
  const data: DebugData | null = query.data?.conversationId === conversationId ? query.data : null
  return { data, error: query.error !== null && !query.loading, refresh: query.reload }
}

export function DebugPanel() {
  const { t } = useTranslation()
  const conversation = useActiveConversation()
  const bots = useAppStore((s) => s.bots)
  const [tab, setTab] = useState<Tab>('calls')
  const { data, error, refresh } = useDebugData(conversation?.id ?? null)
  const display = conversation ? describeConversation(conversation, bots, t('sidebar.groupFallback')) : null

  return (
    <>
      <RightPanelHeader
        variant="bar"
        title={display ? t('panels.debug.titleNamed', { name: display.title }) : t('panels.debug.title')}
        actions={
          <>
            <Segmented
              size="sm"
              role="tab"
              label={t('panels.debug.title')}
              value={tab}
              onChange={setTab}
              options={(['calls', 'context', 'costs'] as const).map((key) => ({
                value: key,
                label: t(`panels.debug.tabs.${key}`),
              }))}
            />
            <Tooltip content={t('panels.debug.refresh')}>
              <button
                type="button"
                onClick={refresh}
                aria-label={t('panels.debug.refresh')}
                className="focus-ring rounded text-fg-muted hover:text-fg"
              >
                <RefreshCw size={14} />
              </button>
            </Tooltip>
          </>
        }
      />
      {!conversation ? (
        <EmptyState hint={t('panels.debug.noConversation')} className="p-10" />
      ) : error ? (
        <EmptyState hint={t('panels.debug.loadFailed')} className="p-10" />
      ) : !data ? (
        <div className="flex flex-1 items-center justify-center">
          <Spinner size={18} className="text-fg-muted" />
        </div>
      ) : data.calls.length === 0 ? (
        <EmptyState hint={t('panels.debug.empty')} className="p-10" />
      ) : tab === 'calls' ? (
        <CallsTab data={data} bots={bots} members={display?.members ?? []} conversationId={conversation.id} />
      ) : tab === 'context' ? (
        <ContextTab
          data={data}
          bots={bots}
          conversationId={conversation.id}
          members={display?.members ?? []}
        />
      ) : (
        <CostsTab debug={data.debug} />
      )}
    </>
  )
}
