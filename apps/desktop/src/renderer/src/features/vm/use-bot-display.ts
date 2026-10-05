import { ApiError, type Bot, type BotDisplay } from '@milibot/shared'
import type { TFunction } from 'i18next'
import { useCallback, useEffect, useRef } from 'react'

import { queryKeys } from '@/api/queries'
import { useApiQuery } from '@/api/use-api-query'
import { useAppStore } from '@/features/workspace/store'

import { getBotDisplay } from './api'

export type DisplayState =
  | { kind: 'loading' }
  | { kind: 'ready'; display: BotDisplay }
  | { kind: 'unavailable'; reason: 'not_ready' | 'error' }

function displayState(display: BotDisplay | null, error: unknown): DisplayState {
  if (error) {
    const notReady =
      error instanceof ApiError && (error.code === 'not_found' || error.code === 'runtime_unavailable')
    return { kind: 'unavailable', reason: notReady ? 'not_ready' : 'error' }
  }
  return display ? { kind: 'ready', display } : { kind: 'loading' }
}

export function useBotDisplay(bot: Bot | null, vmRunning: boolean) {
  const workspaceId = useAppStore((s) => s.workspaceId)
  const enabled = Boolean(bot && workspaceId && vmRunning)
  const query = useApiQuery(
    queryKeys.botDisplay(workspaceId ?? '', bot?.id ?? ''),
    () => getBotDisplay(workspaceId ?? '', bot?.id ?? ''),
    { enabled },
  )
  const { reload } = query
  const refresh = useCallback(() => {
    if (enabled) reload()
  }, [enabled, reload])

  // A status change may come with the screen taken or given back.
  const status = bot?.status
  const seenStatus = useRef(status)
  useEffect(() => {
    if (seenStatus.current === status) return
    seenStatus.current = status
    refresh()
  }, [refresh, status])

  // `bot.screen` events refetch the display (`api/cache-updates.ts`); focus covers events missed while the
  // event stream was reconnecting.
  useEffect(() => {
    const onFocus = () => void refresh()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [refresh])

  return { state: displayState(query.data, query.error), refresh }
}

export function openVmWindow(workspaceId: string, bot: Bot, t: TFunction) {
  void window.milibot.openVmWindow({
    workspaceId,
    botId: bot.id,
    title: t('vmWindow.title', { name: bot.name }),
    mode: 'watch',
  })
}
