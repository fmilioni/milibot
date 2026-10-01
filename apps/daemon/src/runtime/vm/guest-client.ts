import {
  type BotLimits,
  type ExecResult,
  type ExtractKind,
  type ExtractResult,
  GUEST_ROUTES as R,
  type GuestAppliedLimits,
  type GuestExecRequest,
  type GuestFsReadResult,
  type GuestFsWriteResult,
  type GuestHealth,
  type GuestOfficeStatus,
  guestPath,
  type GuestProcEvent,
  type GuestProcInfo,
  type GuestStats,
  type GuestWorkspaceEstimate,
  type GuestWorkspaceExtract,
  type InputAction,
  type ProvisionedBot,
} from '@milibot/shared'

import { sleep } from '../../util/sleep'
import { createGuestTransport, type GuestLane, type GuestTransport } from './guest-transport'

export class GuestError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message)
    this.name = 'GuestError'
  }
}

export interface ExtractOptions {
  /** File name: the extension helps detect the kind. */
  name: string
  /** Skips detection by name and magic bytes. */
  kind?: ExtractKind
  /** PDF only: 1-based inclusive page range (other kinds always come whole). */
  pages?: { first: number; last?: number }
  signal?: AbortSignal
}

/** Chunk size of whole-file copies (a base64 request body stays far below the `/fs/*` limit). */
const FS_CHUNK_BYTES = 4 * 1024 * 1024

export interface FsReadAllOptions {
  chunkBytes?: number
  /** A larger file throws `tooLarge(size)` (default: a `file_too_large` GuestError). */
  maxBytes?: number
  tooLarge?: (size: number) => Error
  /** Receives each chunk at its offset instead of keeping it (the result is then empty). */
  onChunk?: (bytes: Buffer, offset: number) => void | Promise<void>
}

/**
 * `connect`: the connection was never established, so the request never reached the guest and any
 * request can be resent. `socket`: the connection broke mid-request; only idempotent requests are resent.
 */
export type NetworkFailure = 'connect' | 'socket'

const CONNECT_CODES = new Set(['ECONNREFUSED', 'UND_ERR_CONNECT_TIMEOUT', 'EHOSTUNREACH', 'ENETUNREACH'])

export function classifyNetworkError(err: unknown): NetworkFailure | null {
  if (!(err instanceof Error)) return null
  const cause = (err as { cause?: { code?: unknown; syscall?: unknown } }).cause
  const code = typeof cause?.code === 'string' ? cause.code : ''
  // setTypeOfService runs before the request is written, so it never reached the guest.
  if (cause?.syscall === 'connect' || cause?.syscall === 'setTypeOfService' || CONNECT_CODES.has(code))
    return 'connect'
  // undici reports every network failure as a TypeError ("fetch failed").
  return err instanceof TypeError ? 'socket' : null
}

export interface GuestRetryOptions {
  /** Extra attempts after a transient network failure. */
  retries?: number
  baseDelayMs?: number
  maxDelayMs?: number
  onRetry?: (info: { method: string; path: string; attempt: number; error: string }) => void
}

type RetryMode = 'idempotent' | 'connect_only' | 'none'

interface RequestOptions {
  signal?: AbortSignal
  timeoutMs?: number
  accept?: string
  retry?: RetryMode
  /** Defaults to `long` when the request may take more than 30 s. */
  lane?: GuestLane
  /** Raw request body (streamed), sent instead of JSON. */
  stream?: ReadableStream<Uint8Array>
  /** Raw request body in memory (can be resent on retry). */
  bytes?: Uint8Array
}

/**
 * HTTP client of the guest agent (`vm/guest-agent`), reachable on 127.0.0.1:<portBase>.
 *
 * QEMU user networking listens on the forwarded port with a backlog of 1, so when several requests
 * open connections at the same moment (e.g. provisioning a new desktop while its bot starts its first
 * turn) macOS resets the extra ones (`connect ECONNRESET`). The default transport keeps connections
 * alive and opens new ones one at a time (see `guest-transport.ts`); failures that still happen are
 * retried with backoff.
 */
export class GuestClient {
  private readonly retries: number
  private readonly baseDelayMs: number
  private readonly maxDelayMs: number
  private readonly onRetry: GuestRetryOptions['onRetry']
  private readonly transport: GuestTransport | null

  /** Without `doFetch`, requests go through a dedicated keep-alive transport for this guest. */
  constructor(
    readonly baseUrl: string,
    private readonly token: string,
    private readonly doFetch?: typeof fetch,
    retry: GuestRetryOptions = {},
  ) {
    this.transport = doFetch ? null : createGuestTransport(baseUrl)
    this.retries = retry.retries ?? 6
    this.baseDelayMs = retry.baseDelayMs ?? 50
    this.maxDelayMs = retry.maxDelayMs ?? 2000
    this.onRetry = retry.onRetry
  }

  private fetcher(lane: GuestLane): typeof fetch {
    return this.transport?.fetch(lane) ?? (this.doFetch as typeof fetch)
  }

  close(): Promise<void> {
    return this.transport?.close() ?? Promise.resolve()
  }

  private backoff(attempt: number): number {
    const exp = Math.min(this.maxDelayMs, this.baseDelayMs * 2 ** attempt)
    return Math.round(exp / 2 + (Math.random() * exp) / 2)
  }

  private async request(
    method: string,
    path: string,
    body?: unknown,
    options: RequestOptions = {},
  ): Promise<Response> {
    const signals = [
      options.signal,
      options.timeoutMs ? AbortSignal.timeout(options.timeoutMs) : undefined,
    ].filter((s): s is AbortSignal => Boolean(s))
    const signal = signals.length ? AbortSignal.any(signals) : undefined
    const retry = options.retry ?? (method === 'GET' ? 'idempotent' : 'connect_only')
    const doFetch = this.fetcher(
      options.lane ??
        (options.stream || options.bytes || (options.timeoutMs ?? 0) > 30_000 ? 'long' : 'quick'),
    )
    let res: Response
    for (let attempt = 0; ; attempt++) {
      try {
        res = await doFetch(this.baseUrl + path, {
          method,
          headers: {
            authorization: `Bearer ${this.token}`,
            ...(options.stream
              ? { 'content-type': 'application/x-tar' }
              : options.bytes
                ? { 'content-type': 'application/octet-stream' }
                : body !== undefined
                  ? { 'content-type': 'application/json' }
                  : {}),
            ...(options.accept ? { accept: options.accept } : {}),
          },
          body: options.stream ?? options.bytes ?? (body !== undefined ? JSON.stringify(body) : undefined),
          signal,
          ...(options.stream ? { duplex: 'half' } : {}),
        } as RequestInit)
        break
      } catch (err) {
        if (signal?.aborted) throw err
        const failure = classifyNetworkError(err)
        const retriable =
          retry !== 'none' && (failure === 'connect' || (failure === 'socket' && retry === 'idempotent'))
        const cause = (err as { cause?: { message?: unknown } }).cause
        const error = `${(err as Error).message}${typeof cause?.message === 'string' ? ` (${cause.message})` : ''}`
        if (!retriable || attempt >= this.retries) {
          throw new GuestError('unreachable', `guest agent unreachable: ${error}`, 0)
        }
        this.onRetry?.({ method, path, attempt: attempt + 1, error })
        await sleep(this.backoff(attempt), signal)
      }
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      let code = 'http_error'
      let message = text || `HTTP ${res.status}`
      try {
        const parsed = JSON.parse(text) as { error?: { code?: string; message?: string } }
        code = parsed.error?.code ?? code
        message = parsed.error?.message ?? message
      } catch {
        /* not JSON */
      }
      throw new GuestError(code, message, res.status)
    }
    return res
  }

  private async json<T>(method: string, path: string, body?: unknown, options?: RequestOptions): Promise<T> {
    const res = await this.request(method, path, body, options)
    return (await res.json()) as T
  }

  /** Not retried: callers poll it while the VM boots. */
  health(timeoutMs = 5000): Promise<GuestHealth> {
    return this.json('GET', R.health, undefined, { timeoutMs, retry: 'none' })
  }

  /** Not retried: the sampler just waits for the next tick. */
  stats(): Promise<GuestStats> {
    return this.json('GET', R.stats, undefined, { timeoutMs: 10_000, retry: 'none' })
  }

  provisionBot(input: { slug: string; uid: number; display: number }): Promise<ProvisionedBot> {
    return this.json('POST', R.provisionBot, input, { timeoutMs: 180_000, retry: 'idempotent' })
  }

  removeBot(input: { slug: string; deleteHome?: boolean }): Promise<{ removed: boolean }> {
    return this.json('POST', R.removeBot, input, { timeoutMs: 60_000 })
  }

  async screenshot(display: number, signal?: AbortSignal): Promise<Uint8Array> {
    const res = await this.request(
      'POST',
      guestPath(R.screenshot, { n: display }),
      { encoding: 'binary' },
      { signal, timeoutMs: 30_000, accept: 'image/png', retry: 'idempotent' },
    )
    return new Uint8Array(await res.arrayBuffer())
  }

  input(display: number, actions: InputAction[], signal?: AbortSignal): Promise<{ ok: true; steps: number }> {
    return this.json('POST', guestPath(R.input, { n: display }), { actions }, { signal, timeoutMs: 120_000 })
  }

  exec(request: GuestExecRequest, signal?: AbortSignal): Promise<ExecResult> {
    return this.json('POST', R.exec, request, {
      signal,
      timeoutMs: (request.timeoutMs ?? 120_000) + 15_000,
      lane: 'long',
    })
  }

  fsRead(
    path: string,
    options: { encoding?: 'utf8' | 'base64'; maxBytes?: number } = {},
  ): Promise<GuestFsReadResult> {
    return this.json('POST', R.fsRead, { path, ...options }, { retry: 'idempotent' })
  }

  fsWrite(path: string, content: string, owner?: string): Promise<GuestFsWriteResult> {
    return this.json(
      'POST',
      R.fsWrite,
      { path, content, ...(owner ? { owner } : {}) },
      { retry: 'idempotent' },
    )
  }

  /** Writes base64 bytes (`append` adds to the file); missing folders are created owned by `owner`. */
  fsWriteChunk(
    path: string,
    base64: string,
    options: { append: boolean; owner?: string },
  ): Promise<GuestFsWriteResult> {
    return this.json(
      'POST',
      R.fsWrite,
      {
        path,
        content: base64,
        encoding: 'base64',
        append: options.append,
        ...(options.owner ? { owner: options.owner } : {}),
      },
      { timeoutMs: 120_000 },
    )
  }

  fsReadChunk(path: string, offset: number, maxBytes: number): Promise<GuestFsReadResult> {
    return this.json(
      'POST',
      R.fsRead,
      { path, encoding: 'base64', offset, maxBytes },
      { retry: 'idempotent', timeoutMs: 120_000 },
    )
  }

  /** A whole VM file, read in chunks. */
  async fsReadAll(path: string, options: FsReadAllOptions = {}): Promise<Buffer> {
    const { maxBytes, onChunk } = options
    const parts: Buffer[] = []
    let offset = 0
    for (;;) {
      const chunk = await this.fsReadChunk(path, offset, options.chunkBytes ?? FS_CHUNK_BYTES)
      if (maxBytes !== undefined && chunk.size > maxBytes)
        throw (
          options.tooLarge?.(chunk.size) ??
          new GuestError('file_too_large', `${path} is larger than ${maxBytes} bytes`, 413)
        )
      const bytes = Buffer.from(chunk.content, 'base64')
      if (onChunk) await onChunk(bytes, offset)
      else parts.push(bytes)
      offset += bytes.length
      if (!chunk.truncated || bytes.length === 0) break
    }
    return Buffer.concat(parts)
  }

  /** Writes `data` in chunks (an empty file for no bytes); missing folders are created owned by `owner`. */
  async fsWriteAll(
    path: string,
    data: Uint8Array | string,
    options: { owner?: string; chunkBytes?: number } = {},
  ): Promise<void> {
    const bytes = typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data)
    const chunkBytes = options.chunkBytes ?? FS_CHUNK_BYTES
    let offset = 0
    do {
      const part = bytes.subarray(offset, offset + chunkBytes)
      await this.fsWriteChunk(path, part.toString('base64'), {
        append: offset > 0,
        ...(options.owner ? { owner: options.owner } : {}),
      })
      offset += part.length
    } while (offset < bytes.length)
  }

  /** Sends `signal` to the running processes whose label starts with `labelPrefix`; resolves how many. */
  async killProcs(labelPrefix: string, signal = 'SIGTERM'): Promise<number> {
    const { procs } = await this.listProcs()
    let count = 0
    for (const proc of procs) {
      if (!proc.running || !proc.label?.startsWith(labelPrefix)) continue
      await this.procSignal(proc.id, signal).catch(() => undefined)
      count++
    }
    return count
  }

  listProcs(): Promise<{ procs: GuestProcInfo[] }> {
    return this.json('GET', R.procs)
  }

  startProc(request: GuestExecRequest & { label?: string }): Promise<{ id: string; pid?: number }> {
    return this.json('POST', R.procs, request)
  }

  async *procEvents(id: string, since: number, signal: AbortSignal): AsyncGenerator<GuestProcEvent> {
    const res = await this.request('GET', `${guestPath(R.procEvents, { id })}?since=${since}`, undefined, {
      signal,
      lane: 'long',
    })
    if (!res.body) return
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let index: number
        while ((index = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, index).trim()
          buffer = buffer.slice(index + 1)
          if (line) yield JSON.parse(line) as GuestProcEvent
        }
      }
    } finally {
      reader.releaseLock()
      void res.body.cancel().catch(() => undefined)
    }
  }

  procStdin(id: string, data: string, eof = false): Promise<{ ok: true }> {
    return this.json('POST', guestPath(R.procStdin, { id }), { data, eof })
  }

  procSignal(id: string, signal: string): Promise<{ ok: true }> {
    return this.json('POST', guestPath(R.procSignal, { id }), { signal })
  }

  /** Sets (null: clears) the CPU/memory limits of each bot's slice. */
  applyLimits(
    bots: Array<{ slug: string; uid: number }>,
    limits: BotLimits | null,
  ): Promise<{ results: GuestAppliedLimits[] }> {
    return this.json('POST', R.limits, { bots, limits }, { timeoutMs: 60_000, retry: 'idempotent' })
  }

  /** Apparent size and entry count of `/workspace` without the excluded names. */
  estimateWorkspace(excludes: string[], signal?: AbortSignal): Promise<GuestWorkspaceEstimate> {
    return this.json(
      'POST',
      R.workspaceEstimate,
      { excludes },
      { signal, timeoutMs: 330_000, retry: 'idempotent' },
    )
  }

  /** Uncompressed tar of `/workspace`; a failure in the guest breaks the stream. */
  async workspaceTar(excludes: string[], signal: AbortSignal): Promise<ReadableStream<Uint8Array>> {
    const res = await this.request('POST', R.workspaceTar, { excludes }, { signal, lane: 'long' })
    if (!res.body) throw new GuestError('empty_body', 'the guest sent no archive', res.status)
    return res.body
  }

  /**
   * Text of a document (PDF with OCR of scanned pages, docx/odt/epub/rtf/html, xlsx/pptx, images, text files),
   * extracted in the VM by an unprivileged process. Old Office formats (doc/xls/ppt/ods/odp) need LibreOffice
   * (`officeInstall`).
   * Errors (`GuestError.code`): `unsupported_format`, `too_large`, `timeout`, `tools_missing`,
   * `office_missing`, `extract_failed`.
   */
  extract(bytes: Uint8Array, options: ExtractOptions): Promise<ExtractResult> {
    const query = new URLSearchParams({ name: options.name })
    if (options.kind) query.set('kind', options.kind)
    if (options.pages) {
      query.set('first', String(options.pages.first))
      if (options.pages.last !== undefined) query.set('last', String(options.pages.last))
    }
    return this.json('POST', `${R.extract}?${query}`, undefined, {
      bytes,
      signal: options.signal,
      timeoutMs: 30 * 60_000,
      lane: 'long',
      retry: 'idempotent',
    })
  }

  officeStatus(): Promise<GuestOfficeStatus> {
    return this.json('GET', R.office)
  }

  /** Starts installing LibreOffice in the background (poll `officeStatus`). */
  officeInstall(): Promise<GuestOfficeStatus> {
    return this.json('POST', R.officeInstall)
  }

  /** Starts purging LibreOffice in the background. */
  officeRemove(): Promise<GuestOfficeStatus> {
    return this.json('POST', R.officeRemove)
  }

  /** Extracts a tar into `/workspace` (existing files are overwritten). */
  extractWorkspace(tar: ReadableStream<Uint8Array>, signal: AbortSignal): Promise<GuestWorkspaceExtract> {
    return this.json('POST', R.workspaceExtract, undefined, { signal, stream: tar, retry: 'none' })
  }
}
