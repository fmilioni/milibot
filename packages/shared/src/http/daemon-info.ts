import { z } from 'zod'

import { endpoint, Ok } from './endpoint'

/** Contents of `dataLayout(root).daemonInfo`, written by the supervisor once it is listening. */
export const DaemonInfo = z.object({
  pid: z.number().int(),
  host: z.literal('127.0.0.1'),
  port: z.number().int().positive(),
  token: z.string().min(32),
  version: z.string(),
  startedAt: z.number().int(),
})
export type DaemonInfo = z.infer<typeof DaemonInfo>

export const AUTH_QUERY_PARAM = 'token'

export const Health = z.object({
  ok: z.literal(true),
  pid: z.number().int(),
  version: z.string(),
  startedAt: z.number().int(),
})

export const daemonEndpoints = {
  health: endpoint({ method: 'GET', path: '/health', response: Health }),
  /**
   * Answers first, then stops the runtimes (suspending `suspend_vm` VMs) and exits. Replaces SIGTERM where
   * signals cannot run handlers (Windows); signals stay as a fallback.
   */
  shutdown: endpoint({ method: 'POST', path: '/shutdown', response: Ok }),
}

export function daemonBaseUrl(info: Pick<DaemonInfo, 'host' | 'port'>): string {
  return `http://${info.host}:${info.port}`
}

/** Whether the daemon of `info` answers `/health` within `timeoutMs` (the pid is not checked). */
export async function isDaemonHealthy(
  info: Pick<DaemonInfo, 'host' | 'port' | 'token'>,
  timeoutMs: number,
  doFetch: typeof fetch = fetch,
): Promise<boolean> {
  try {
    const res = await doFetch(daemonBaseUrl(info) + daemonEndpoints.health.path, {
      headers: { authorization: `Bearer ${info.token}` },
      signal: AbortSignal.timeout(timeoutMs),
    })
    return res.ok
  } catch {
    return false
  }
}
