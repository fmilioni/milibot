export interface ApiHeaderOptions {
  apiKey?: string | null
  extraHeaders?: Record<string, string>
  /** Adds `content-type: application/json` (overridable by `extraHeaders`). */
  json?: boolean
  /** Adds OpenRouter's app attribution unless `extraHeaders` set it. */
  openRouter?: boolean
}

/** Headers of a request to an OpenAI-style server: the user's extra headers, then the bearer key. */
export function apiHeaders(options: ApiHeaderOptions): Record<string, string> {
  const headers: Record<string, string> = {
    ...(options.json ? { 'content-type': 'application/json' } : {}),
    ...options.extraHeaders,
  }
  if (options.apiKey) headers.authorization = `Bearer ${options.apiKey}`
  if (options.openRouter) {
    headers['http-referer'] ??= 'https://milibot.local'
    headers['x-title'] ??= 'Milibot'
  }
  return headers
}
