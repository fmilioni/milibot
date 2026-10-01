import {
  api,
  type EndpointBody,
  type EndpointName,
  type EndpointParams,
  type EndpointQuery,
  type EndpointResponse,
} from './api'
import { ApiError, ApiErrorBody } from './errors'
import { buildPath } from './path'

type KeysOf<T> = keyof T extends never ? true : false

export type CallArgs<N extends EndpointName> = (KeysOf<EndpointParams<N>> extends true
  ? { params?: undefined }
  : { params: EndpointParams<N> }) &
  (EndpointBody<N> extends undefined ? { body?: undefined } : { body: EndpointBody<N> }) &
  (EndpointQuery<N> extends undefined ? { query?: undefined } : { query?: EndpointQuery<N> }) & {
    /** Aborting rejects with the signal's reason (not an `ApiError`). */
    signal?: AbortSignal
  }

export interface ApiClientOptions {
  baseUrl: string
  token: string
  fetch?: typeof fetch
  /** Validates responses against their schema (tests; costs CPU in the UI). */
  validateResponses?: boolean
}

export interface ApiClient {
  call<N extends EndpointName>(name: N, args: CallArgs<N>): Promise<EndpointResponse<N>>
}

export function createApiClient(options: ApiClientOptions): ApiClient {
  const doFetch = options.fetch ?? fetch
  return {
    async call(name, args) {
      const def = api[name]
      const params = (args.params ?? {}) as Record<string, string>
      let url = options.baseUrl + buildPath(def.path, params)
      const query = args.query as Record<string, unknown> | undefined
      if (query) {
        const search = new URLSearchParams()
        for (const [key, value] of Object.entries(query)) {
          if (value !== undefined && value !== null) search.set(key, String(value))
        }
        const qs = search.toString()
        if (qs) url += `?${qs}`
      }
      const headers: Record<string, string> = { authorization: `Bearer ${options.token}` }
      let body: string | undefined
      if (args.body !== undefined) {
        headers['content-type'] = 'application/json'
        body = JSON.stringify(args.body)
      }
      let res: Response
      try {
        res = await doFetch(url, { method: def.method, headers, body, signal: args.signal })
      } catch (err) {
        if (args.signal?.aborted) throw args.signal.reason
        throw new ApiError('network', err instanceof Error ? err.message : String(err), 0)
      }
      const text = await res.text()
      if (!res.ok) {
        const parsed = ApiErrorBody.safeParse(parseJson(text))
        if (parsed.success) {
          const { code, message, details } = parsed.data.error
          throw new ApiError(code, message, res.status, details)
        }
        throw new ApiError('internal', `HTTP ${res.status}`, res.status)
      }
      const json: unknown = text ? JSON.parse(text) : undefined
      return (options.validateResponses ? def.response.parse(json) : json) as never
    },
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}
