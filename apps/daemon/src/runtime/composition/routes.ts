import { api, type EndpointName } from '@milibot/shared'

import { DaemonError } from '../../errors'
import { parseEndpointInput } from '../../handlers'
import type { WorkspaceEndpointName } from '../../ipc/protocol'

type HandlerSet = { readonly [K in EndpointName]?: (args: never) => unknown }

type Merged<T extends readonly HandlerSet[]> = (T[number] extends infer U
  ? (U extends unknown ? (u: U) => void : never) extends (i: infer I) => void
    ? I
    : never
  : never) &
  HandlerSet

/**
 * Merges the route sets of the domains (each one a service's `handlers()`); an endpoint two sets serve is a
 * wiring bug and throws, where a spread would let the last one win silently.
 */
export function collectHandlers<T extends readonly HandlerSet[]>(...sets: T): Merged<T> {
  const merged: Record<string, unknown> = {}
  for (const set of sets) {
    for (const [name, handler] of Object.entries(set)) {
      if (Object.hasOwn(merged, name)) throw new Error(`endpoint ${name} is served twice`)
      merged[name] = handler
    }
  }
  return merged as Merged<T>
}

/** Runs a workspace endpoint: input validated against its `api` declaration, then its handler. */
export function dispatch(
  handlers: HandlerSet,
  endpoint: WorkspaceEndpointName,
  params: Record<string, string>,
  query: unknown,
  body: unknown,
): unknown {
  const handler = Object.hasOwn(handlers, endpoint) ? handlers[endpoint] : undefined
  if (!handler || !api[endpoint].path.startsWith('/w/'))
    throw new DaemonError('not_found', `Unknown endpoint: ${endpoint}`)
  return (handler as (args: unknown) => unknown)(parseEndpointInput(endpoint, params, query, body))
}
