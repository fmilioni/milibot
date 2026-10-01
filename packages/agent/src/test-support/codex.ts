import { readFileSync } from 'node:fs'

import type { GuestCliBackend, GuestProcEvent, GuestProcSpec } from '../cli/backend'
import type { CliTurnIO } from '../cli/engine'
import type { RateLimitSnapshot } from '../codex/protocol'

/** Notifications of one recorded turn in `codex/fixtures/` (real `codex app-server` output, paths sanitized). */
export function readCodexFixture(name: string): Array<Record<string, unknown>> {
  return readFileSync(new URL(`../codex/fixtures/${name}`, import.meta.url), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

type Reply = { result: unknown } | { error: { code: number; message: string } }

export interface FakeRequest {
  procId: string
  id: number
  method: string
  params: Record<string, unknown>
}

/**
 * Fake `codex app-server` behind the guest process API: answers JSON-RPC requests written to stdin and, on
 * `turn/start`, replays `turnScript` (with the thread and turn ids of the call).
 */
export class FakeCodexBackend implements GuestCliBackend {
  specs: GuestProcSpec[] = []
  requests: FakeRequest[] = []
  /** Answers the client wrote to requests of the server. */
  answers: Array<Record<string, unknown>> = []
  signals: string[] = []
  /** Signals the process ignores (by default SIGINT and SIGTERM end it, SIGKILL always does). */
  ignoredSignals = new Set<string>()
  sessions = new Map<string, string | null>()
  /** Notifications played after each `turn/start` (in order; the last one repeats). */
  turnScripts: Array<Array<Record<string, unknown>>> = [readCodexFixture('turn-tools.ndjson')]
  /** Overrides by method (return undefined to use the default answer). */
  handlers: Record<string, (req: FakeRequest) => Reply | undefined> = {}
  threadCounter = 0
  turnCounter = 0
  private listeners = new Map<string, (e: GuestProcEvent) => void>()
  private backlog = new Map<string, GuestProcEvent[]>()
  private seq = 0
  private turnsStarted = 0

  async startProcess(spec: GuestProcSpec) {
    this.specs.push(spec)
    const id = `proc-${this.specs.length}`
    this.backlog.set(id, [])
    return { id }
  }

  push(procId: string, event: { type: string; [key: string]: unknown }) {
    const full = { ...event, seq: ++this.seq } as GuestProcEvent
    const listener = this.listeners.get(procId)
    if (listener) listener(full)
    else this.backlog.get(procId)?.push(full)
  }

  /** Writes a JSON line on the process's stdout. */
  emit(procId: string, message: Record<string, unknown>) {
    this.push(procId, { type: 'stdout', data: JSON.stringify(message) })
  }

  events(procId: string, _since: number, signal: AbortSignal): AsyncIterable<GuestProcEvent> {
    const queue: GuestProcEvent[] = [...(this.backlog.get(procId) ?? [])]
    let wake: (() => void) | null = null
    this.listeners.set(procId, (e) => {
      queue.push(e)
      wake?.()
    })
    return {
      async *[Symbol.asyncIterator]() {
        while (!signal.aborted) {
          const next = queue.shift()
          if (next) {
            yield next
            if (next.type === 'exit') return
            continue
          }
          await new Promise<void>((resolve) => {
            wake = resolve
            signal.addEventListener('abort', () => resolve(), { once: true })
          })
        }
      },
    }
  }

  async writeStdin(procId: string, data: string) {
    for (const line of data.split('\n').filter(Boolean)) {
      const message = JSON.parse(line) as Record<string, unknown>
      if (typeof message.method !== 'string') {
        this.answers.push(message)
        continue
      }
      if (message.id === undefined) continue
      const req: FakeRequest = {
        procId,
        id: message.id as number,
        method: message.method,
        params: (message.params ?? {}) as Record<string, unknown>,
      }
      this.requests.push(req)
      const reply = this.handlers[req.method]?.(req) ?? this.defaultReply(req)
      setTimeout(() => {
        this.emit(procId, { id: req.id, ...reply })
        if (req.method === 'turn/start' && 'result' in reply)
          this.playTurn(req, reply.result as { turn: { id: string } })
      }, 1)
    }
  }

  private playTurn(req: FakeRequest, result: { turn: { id: string } }) {
    const script = this.turnScripts[Math.min(this.turnsStarted, this.turnScripts.length - 1)] ?? []
    this.turnsStarted++
    this.play(req.procId, req.params.threadId as string, result.turn.id, script)
  }

  /** Emits recorded notifications as if they belonged to `threadId`/`turnId` (a user message gets `clientId`). */
  play(
    procId: string,
    threadId: string,
    turnId: string,
    script: Array<Record<string, unknown>>,
    clientId?: string,
  ) {
    const retag = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(retag)
      if (!value || typeof value !== 'object') return value
      const out: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(value)) {
        if (k === 'threadId') out[k] = threadId
        else if (k === 'turnId') out[k] = turnId
        else if (k === 'clientId' && clientId && v) out[k] = clientId
        else out[k] = retag(v)
      }
      return out
    }
    for (const message of script) {
      const m = retag(message) as Record<string, unknown>
      if (m.method === 'turn/started' || m.method === 'turn/completed') {
        const params = m.params as { turn: Record<string, unknown> }
        params.turn = { ...params.turn, id: turnId }
      }
      this.emit(procId, m)
    }
  }

  private defaultReply(req: FakeRequest): Reply {
    switch (req.method) {
      case 'initialize':
        return {
          result: {
            userAgent: 'codex/0.159.2',
            codexHome: '/home/agent/.codex',
            platformFamily: 'unix',
            platformOs: 'linux',
          },
        }
      case 'thread/start':
        return {
          result: {
            thread: { id: `thread-${++this.threadCounter}`, path: null, model: 'gpt-6.1-sol' },
            model: 'gpt-6.1-sol',
          },
        }
      case 'thread/resume':
        return {
          result: {
            thread: { id: req.params.threadId, path: null, model: 'gpt-6.1-sol' },
            model: 'gpt-6.1-sol',
          },
        }
      case 'turn/start':
        return {
          result: {
            turn: { id: `turn-${++this.turnCounter}`, status: 'inProgress', error: null, durationMs: null },
          },
        }
      case 'turn/steer':
        return { result: { turnId: req.params.expectedTurnId } }
      case 'turn/interrupt':
        return { result: {} }
      default:
        return { error: { code: -32601, message: `unknown method ${req.method}` } }
    }
  }

  async signal(procId: string, sig: string) {
    this.signals.push(sig)
    if (this.ignoredSignals.has(sig)) return
    if (sig === 'SIGINT' || sig === 'SIGTERM' || sig === 'SIGKILL')
      setTimeout(
        () => this.push(procId, { type: 'exit', code: sig === 'SIGKILL' ? null : 143, signal: null }),
        1,
      )
  }

  async writeAgentFile(name: string) {
    return `/home/agent/.milibot/${name}`
  }

  async mcpEndpoint(botId: string, laneKey: string) {
    return { url: 'http://10.0.2.2:5555/mcp', token: `tok-${botId}-${laneKey}` }
  }

  getSessionId(laneKey: string) {
    return this.sessions.get(laneKey) ?? null
  }

  setSessionId(laneKey: string, id: string | null) {
    this.sessions.set(laneKey, id)
  }

  methods(): string[] {
    return this.requests.map((r) => r.method)
  }
}

export function codexRecorder(signal = new AbortController().signal) {
  const log: string[] = []
  const io: CliTurnIO = {
    signal,
    onTextDelta: (t) => log.push(`delta:${t}`),
    onTextBoundary: (t) => log.push(`boundary:${t ?? ''}`),
    onToolUse: () => log.push('tool_use'),
    onNativeToolStart: (id, name) => log.push(`start:${name}`),
    onNativeToolFinish: (id, isError, _output, diffs) =>
      log.push(
        `finish:${isError}${diffs.length ? `:${diffs.map((d) => `${d.status} ${d.path}`).join(',')}` : ''}`,
      ),
    onInputTaken: () => log.push('taken'),
    onQuota: (s) => log.push(`rate:${(s as RateLimitSnapshot).primary?.usedPercent ?? '-'}`),
  }
  return { io, log }
}
