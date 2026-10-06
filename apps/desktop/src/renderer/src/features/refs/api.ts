import { MAX_REFS_PER_RESOLVE, type RefInfo } from '@milibot/shared'

import { api } from '@/api/daemon'

interface Pending {
  promise: Promise<RefInfo | null>
  resolve: (info: RefInfo | null) => void
  reject: (err: unknown) => void
}

interface Queue {
  /** Ids asked for since the last flush. */
  pending: Map<string, Pending>
  /** Ids sent and not answered yet: asking again joins that request. */
  inFlight: Map<string, Promise<RefInfo | null>>
  timer: ReturnType<typeof setTimeout> | null
  lastFlushAt: number
}

/**
 * At most one call per window and workspace. A message rendered at once still goes in one call right away;
 * a reply streaming its ids one by one gets them grouped instead of one call per id.
 */
export const RESOLVE_WINDOW_MS = 600

const queues = new Map<string, Queue>()

function queueOf(workspaceId: string): Queue {
  let queue = queues.get(workspaceId)
  if (!queue) {
    queue = { pending: new Map(), inFlight: new Map(), timer: null, lastFlushAt: -Infinity }
    queues.set(workspaceId, queue)
  }
  return queue
}

async function flush(workspaceId: string, queue: Queue): Promise<void> {
  queue.timer = null
  queue.lastFlushAt = Date.now()
  const batch = queue.pending
  queue.pending = new Map()
  for (const [id, entry] of batch) queue.inFlight.set(id, entry.promise)
  const ids = [...batch.keys()]
  for (let start = 0; start < ids.length; start += MAX_REFS_PER_RESOLVE) {
    const chunk = ids.slice(start, start + MAX_REFS_PER_RESOLVE)
    try {
      const { refs } = await api().call('resolveRefs', { params: { workspaceId }, body: { ids: chunk } })
      const found = new Map(refs.map((ref) => [ref.id, ref]))
      for (const id of chunk) batch.get(id)?.resolve(found.get(id) ?? null)
    } catch (err) {
      for (const id of chunk) batch.get(id)?.reject(err)
    } finally {
      for (const id of chunk) queue.inFlight.delete(id)
    }
  }
}

/** The current name of an id written in text, or null when it doesn't exist (batched, see above). */
export function loadRef(workspaceId: string, id: string): Promise<RefInfo | null> {
  const queue = queueOf(workspaceId)
  const known = queue.inFlight.get(id) ?? queue.pending.get(id)?.promise
  if (known) return known
  let resolve!: Pending['resolve']
  let reject!: Pending['reject']
  const promise = new Promise<RefInfo | null>((res, rej) => {
    resolve = res
    reject = rej
  })
  queue.pending.set(id, { promise, resolve, reject })
  if (!queue.timer) {
    const wait = Math.max(0, queue.lastFlushAt + RESOLVE_WINDOW_MS - Date.now())
    queue.timer = setTimeout(() => void flush(workspaceId, queue), wait)
  }
  return promise
}

/** Brings a file under `/workspace/` from the VM and opens it (or shows it in its folder, see `openPath`). */
export async function openWorkspaceFile(workspaceId: string, path: string): Promise<void> {
  const exported = await api().call('exportWorkspaceFile', { params: { workspaceId }, body: { path } })
  await window.milibot.openPath(exported.path)
}
