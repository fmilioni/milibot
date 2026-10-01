import { type Api, api, type EndpointName, type EndpointParams, type EndpointResponse } from '@milibot/shared'
import type { z } from 'zod'

import { DaemonError } from './errors'

export type Parsed<S> = S extends z.ZodType ? z.output<S> : undefined

export interface HandlerArgs<N extends EndpointName> {
  params: EndpointParams<N>
  query: Parsed<Api[N]['query']>
  body: Parsed<Api[N]['body']>
}

export type EndpointHandlers<N extends EndpointName> = {
  [K in N]: (args: HandlerArgs<K>) => EndpointResponse<K> | Promise<EndpointResponse<K>>
}

function parseInput<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const result = schema.safeParse(value ?? {})
  if (!result.success) throw new DaemonError('validation_failed', 'Invalid request', result.error.issues)
  return result.data
}

/** Path params, query and body of a request, validated against the endpoint's declaration in `api`. */
export function parseEndpointInput<N extends EndpointName>(
  name: N,
  params: Record<string, string>,
  query: unknown,
  body: unknown,
): HandlerArgs<N> {
  const def: { params?: z.ZodType; query?: z.ZodType; body?: z.ZodType } = api[name]
  return {
    params: def.params ? { ...params, ...(parseInput(def.params, params) as object) } : params,
    query: def.query ? parseInput(def.query, query) : undefined,
    body: def.body ? parseInput(def.body, body) : undefined,
  } as HandlerArgs<N>
}
