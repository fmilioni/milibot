import { readFileSync } from 'node:fs'

import { claudeCodeDriver } from '../claude-code'
import type { GuestCliBackend, GuestProcEvent, GuestProcSpec } from '../cli/backend'
import type { CliTurnIO } from '../cli/engine'
import type { CliPrompt } from '../cli/prompt'
import { COMPACT_SYSTEM_PROMPT } from '../prompts/lanes'

/** Lines of a recorded `claude -p` stream-json output in `claude-code/fixtures/`. */
export function readFixture(name: string): string[] {
  return readFileSync(new URL(`../claude-code/fixtures/${name}`, import.meta.url), 'utf8')
    .trim()
    .split('\n')
}

export const turnFixture = readFixture('turn.ndjson')

/** Fake guest process API: replays the fixture when a user line arrives on stdin. */
export class FakeBackend implements GuestCliBackend {
  specs: GuestProcSpec[] = []
  stdin: string[] = []
  signals: string[] = []
  files = new Map<string, string>()
  sessions = new Map<string, string | null>()
  /** Signals the process ignores (by default SIGINT and SIGTERM end it, SIGKILL always does). */
  ignoredSignals = new Set<string>()
  /** Lines longer than this reach stdout in pieces flagged `partial`, like the guest splits them. */
  splitLinesOver: number | null = null
  /** `--append-system-prompt-file` content of each process, by spec index. */
  appendedPrompts: string[] = []
  private listeners = new Map<string, (e: GuestProcEvent) => void>()
  private backlog = new Map<string, GuestProcEvent[]>()
  private seq = 0
  script: string[] = turnFixture

  async startProcess(spec: GuestProcSpec) {
    this.specs.push(spec)
    const id = `proc-${this.specs.length}`
    this.backlog.set(id, [])
    const file = spec.argv[spec.argv.indexOf('--append-system-prompt-file') + 1]
    this.appendedPrompts.push(spec.argv.includes('--append-system-prompt-file') ? this.fileAt(file) : '')
    return { id }
  }

  /** Content of a file written with `writeAgentFile`, by the path it returned. */
  fileAt(path: string | undefined): string {
    return this.files.get(path?.split('/').at(-1) ?? '') ?? ''
  }

  /** Writes a line on the process's stdout (split when longer than `splitLinesOver`). */
  emitLine(id: string, line: string) {
    const size = this.splitLinesOver
    if (!size || line.length <= size) return this.push(id, { type: 'stdout', data: line })
    for (let at = 0; at < line.length; at += size)
      this.push(id, { type: 'stdout', data: line.slice(at, at + size), partial: at + size < line.length })
  }

  push(id: string, event: { type: string; [key: string]: unknown }) {
    const full = { ...event, seq: ++this.seq } as GuestProcEvent
    const listener = this.listeners.get(id)
    if (listener) listener(full)
    else this.backlog.get(id)?.push(full)
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

  scriptFor: ((procId: string) => string[] | null) | null = null

  async writeStdin(procId: string, data: string) {
    this.stdin.push(data)
    if (!data) return
    const script = this.scriptFor?.(procId) ?? this.script
    setTimeout(() => {
      for (const line of script) this.emitLine(procId, line)
    }, 1)
  }

  async signal(procId: string, sig: string) {
    this.signals.push(sig)
    if (this.ignoredSignals.has(sig)) return
    if (sig === 'SIGINT' || sig === 'SIGTERM' || sig === 'SIGKILL')
      setTimeout(
        () => this.push(procId, { type: 'exit', code: sig === 'SIGKILL' ? null : 130, signal: null }),
        1,
      )
  }

  async writeAgentFile(name: string, content: string) {
    this.files.set(name, content)
    return `/home/agent/.milibot/${name}`
  }

  async mcpEndpoint(botId: string) {
    return { url: 'http://10.0.2.2:5555/mcp', token: `tok-${botId}` }
  }

  getSessionId(botId: string) {
    return this.sessions.get(botId) ?? null
  }

  setSessionId(botId: string, id: string | null) {
    this.sessions.set(botId, id)
  }
}

export function recorder(signal = new AbortController().signal) {
  const log: string[] = []
  const io: CliTurnIO = {
    signal,
    onMcpStatus: (connected) => log.push(`mcp:${connected}`),
    onTextDelta: (t) => log.push(`delta:${t}`),
    onTextBoundary: (t) => log.push(`boundary:${t ?? ''}`),
    onNativeToolStart: (id, name) => log.push(`start:${name}:${id}`),
    onNativeToolFinish: (id, isError) => log.push(`finish:${id}:${isError}`),
  }
  return { io, log }
}

/** Profile of a chat-lane session started with `prompt` (compact system prompt unless `compact` is false). */
export function claudeProfile(prompt: CliPrompt, compact = true): string {
  return claudeCodeDriver.profile({
    settings: {
      rotateIdleMinutes: 55,
      rotateContextTokens: 60_000,
      systemPrompt: compact ? COMPACT_SYSTEM_PROMPT : null,
    },
    instructions: prompt.instructions,
    mcpTools: prompt.mcpTools,
    nativeTools: claudeCodeDriver.nativeTools({ inSession: false, readOnly: false }),
    externalFingerprint: '',
  })
}
