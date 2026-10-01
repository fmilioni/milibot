import type { VmStats } from '@milibot/shared'
import { useEffect, useState } from 'react'

import { getVmStats } from './api'

/** Right after boot the runtime needs a second reading before it has numbers. */
const RETRY_MS = 1500

/** Live VM usage, polled at the runtime's sampling interval only while `active` (on screen). */
export function useVmStats(workspaceId: string | null, active: boolean): VmStats | null {
  const [latest, setLatest] = useState<{ workspaceId: string; stats: VmStats | null } | null>(null)
  useEffect(() => {
    if (!workspaceId || !active) return
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const poll = async () => {
      const stats = await getVmStats(workspaceId)
        .then((r) => r.stats)
        .catch(() => null)
      if (stopped) return
      setLatest({ workspaceId, stats })
      timer = setTimeout(() => void poll(), stats ? stats.intervalSec * 1000 : RETRY_MS)
    }
    void poll()
    return () => {
      stopped = true
      clearTimeout(timer)
    }
  }, [workspaceId, active])
  return active && latest?.workspaceId === workspaceId ? latest.stats : null
}
