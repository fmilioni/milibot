import { MAX_REFS_PER_RESOLVE, type RefInfo } from '@milibot/shared'

import { api } from '@/api/daemon'

interface Waiter {
  resolve: (info: RefInfo | null) => void
  reject: (err: unknown) => void
}

/** Ids asked for since the last flush, per workspace. */
const pending = new Map<string, Map<string, Waiter[]>>()

async function flush(workspaceId: string): Promise<void> {
  const batch = pending.get(workspaceId)
  pending.delete(workspaceId)
  if (!batch) return
  const ids = [...batch.keys()]
  for (let start = 0; start < ids.length; start += MAX_REFS_PER_RESOLVE) {
    const chunk = ids.slice(start, start + MAX_REFS_PER_RESOLVE)
    try {
      const { refs } = await api().call('resolveRefs', { params: { workspaceId }, body: { ids: chunk } })
      const found = new Map(refs.map((ref) => [ref.id, ref]))
      for (const id of chunk) for (const waiter of batch.get(id) ?? []) waiter.resolve(found.get(id) ?? null)
    } catch (err) {
      for (const id of chunk) for (const waiter of batch.get(id) ?? []) waiter.reject(err)
    }
  }
}

/**
 * The current name of an id written in text, or null when it doesn't exist. The ids asked for in the same
 * tick (a message full of them, a whole list rendering) go to the daemon in one call.
 */
export function loadRef(workspaceId: string, id: string): Promise<RefInfo | null> {
  return new Promise((resolve, reject) => {
    let batch = pending.get(workspaceId)
    if (!batch) {
      batch = new Map()
      pending.set(workspaceId, batch)
      setTimeout(() => void flush(workspaceId), 0)
    }
    batch.set(id, [...(batch.get(id) ?? []), { resolve, reject }])
  })
}

/** Brings a file under `/workspace/` from the VM and opens it (or shows it in its folder, see `openPath`). */
export async function openWorkspaceFile(workspaceId: string, path: string): Promise<void> {
  const exported = await api().call('exportWorkspaceFile', { params: { workspaceId }, body: { path } })
  await window.milibot.openPath(exported.path)
}
