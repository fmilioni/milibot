import { z } from 'zod'

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

/**
 * `app` endpoints are served by the supervisor itself; `workspace` endpoints live under
 * `/w/:workspaceId` and are forwarded to that workspace's runtime process.
 */
export type EndpointScope = 'app' | 'workspace'

export interface EndpointDef<
  Path extends string = string,
  Body extends z.ZodType | undefined = z.ZodType | undefined,
  Query extends z.ZodType | undefined = z.ZodType | undefined,
  Response extends z.ZodType = z.ZodType,
  Params extends z.ZodType | undefined = z.ZodType | undefined,
> {
  method: HttpMethod
  path: Path
  scope: EndpointScope
  body: Body
  query: Query
  response: Response
  /** Narrows some path params (e.g. an enum); the others stay plain strings. */
  params: Params
}

export function endpoint<
  Path extends string,
  Response extends z.ZodType,
  Body extends z.ZodType | undefined = undefined,
  Query extends z.ZodType | undefined = undefined,
  Params extends z.ZodType | undefined = undefined,
>(def: {
  method: HttpMethod
  path: Path
  response: Response
  body?: Body
  query?: Query
  params?: Params
}): EndpointDef<Path, Body, Query, Response, Params> {
  return {
    method: def.method,
    path: def.path,
    scope: def.path.startsWith('/w/:workspaceId') ? 'workspace' : 'app',
    body: def.body as Body,
    query: def.query as Query,
    response: def.response,
    params: def.params as Params,
  }
}

type EndpointMap = Record<string, EndpointDef>
type Merged<M extends readonly EndpointMap[]> = M extends readonly [
  infer Head,
  ...infer Rest extends readonly EndpointMap[],
]
  ? Head & Merged<Rest>
  : unknown

/** One object with every endpoint of `maps`; a name or a method + path declared twice throws. */
export function defineApi<const M extends readonly EndpointMap[]>(
  ...maps: M
): { [K in keyof Merged<M>]: Merged<M>[K] } {
  const api: EndpointMap = {}
  const routes = new Map<string, string>()
  for (const map of maps) {
    for (const [name, def] of Object.entries(map)) {
      if (name in api) throw new Error(`Endpoint declared twice: ${name}`)
      const route = `${def.method} ${def.path}`
      const other = routes.get(route)
      if (other) throw new Error(`Route declared twice: ${route} (${other}, ${name})`)
      routes.set(route, name)
      api[name] = def
    }
  }
  return api as { [K in keyof Merged<M>]: Merged<M>[K] }
}

export const Ok = z.object({ ok: z.literal(true) })

/** A boolean query param: `true`/`false`/`1`/`0` in the URL, or a boolean from the typed client. */
export const QueryBool = z
  .union([z.boolean(), z.enum(['true', 'false', '1', '0'])])
  .transform((v) => v === true || v === 'true' || v === '1')

/** An optional boolean query param that falls back to `defaultValue` when absent. */
export function queryBool(defaultValue: boolean) {
  return QueryBool.optional().transform((v) => v ?? defaultValue)
}
