import { abortableSleep } from '../llm/http/sleep'
import { ImageGenerationError, type ImageServer } from './types'

const REQUEST_TIMEOUT_MS = 180_000
const BUSY = new Set([408, 500, 502, 503, 504, 520, 522, 524, 529])
/** Waits before each retry of a rate limit or a busy server; the bot never has to wait and retry itself. */
const RETRY_DELAYS_MS = [2_000, 8_000, 20_000]
const MAX_RETRY_AFTER_MS = 30_000
/** A 429 that no wait fixes: the free tier doesn't cover the model, or the account is out of credit. */
const NO_QUOTA =
  /limit:\s*0\b|free.?tier|billing|credit|insufficient|quota exceeded|exceeded your current quota/i

export interface JsonRequest {
  url: string
  headers: Record<string, string>
  body: string | FormData
  signal?: AbortSignal
}

function parseJson(text: string): unknown {
  try {
    return text ? JSON.parse(text) : null
  } catch {
    return null
  }
}

/** The provider's message, first line only (Google appends a long list of quota metrics). */
function errorText(json: unknown, text: string): string {
  const error = (json as { error?: { message?: unknown } | string } | null)?.error
  const message = typeof error === 'string' ? error : error?.message
  const full = typeof message === 'string' && message ? message : text
  return (full.trim().split('\n')[0] ?? '').slice(0, 300)
}

function retryAfterMs(res: Response): number | null {
  const seconds = Number(res.headers.get('retry-after'))
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(MAX_RETRY_AFTER_MS, seconds * 1000) : null
}

function sleepUnlessAborted(ms: number, signal?: AbortSignal): Promise<void> {
  return abortableSleep(ms, signal, () => new ImageGenerationError('aborted', 'image generation aborted'))
}

function statusError(status: number, message: string): ImageGenerationError {
  const text = `HTTP ${status}: ${message}`
  if (status === 402 || (status === 429 && NO_QUOTA.test(message)))
    return new ImageGenerationError('quota', text, status)
  if (status === 429) return new ImageGenerationError('rate_limited', text, status)
  return new ImageGenerationError('provider_error', text, status)
}

export async function postJson(server: ImageServer, request: JsonRequest): Promise<unknown> {
  const doFetch = server.fetch ?? fetch
  const sleep = server.sleep ?? sleepUnlessAborted
  for (let attempt = 0; ; attempt++) {
    const signal = request.signal
      ? AbortSignal.any([request.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)])
      : AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    let res: Response
    try {
      res = await doFetch(request.url, {
        method: 'POST',
        headers: request.headers,
        body: request.body,
        signal,
      })
    } catch (err) {
      if (request.signal?.aborted) throw new ImageGenerationError('aborted', 'image generation aborted')
      throw new ImageGenerationError('provider_error', `provider error: ${(err as Error).message}`)
    }
    const text = await res.text().catch(() => '')
    const json = parseJson(text)
    if (res.ok) {
      if (json === null) throw new ImageGenerationError('invalid_response', 'the provider answered no JSON')
      return json
    }
    const error = statusError(res.status, errorText(json, text))
    const retryable = error.code === 'rate_limited' || BUSY.has(res.status)
    const delay = RETRY_DELAYS_MS[attempt]
    if (!retryable || delay === undefined || request.signal?.aborted) throw error
    await sleep(retryAfterMs(res) ?? delay, request.signal)
  }
}

export function fromDataUrl(url: string): { bytes: Uint8Array; mediaType: string } | null {
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(url)
  if (!match) return null
  return { mediaType: match[1] as string, bytes: new Uint8Array(Buffer.from(match[2] as string, 'base64')) }
}
