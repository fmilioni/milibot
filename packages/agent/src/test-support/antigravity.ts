import { readFileSync } from 'node:fs'

import type { GuestCliBackend, GuestProcEvent, GuestProcSpec } from '../cli/backend'

/** Lines of a recorded `agy` stream-json output in `antigravity/fixtures/` (real output of `ANTIGRAVITY_VERSION`). */
export function readAntigravityFixture(name: string): string[] {
  return readFileSync(new URL(`../antigravity/fixtures/${name}`, import.meta.url), 'utf8')
    .trim()
    .split('\n')
}

const initLine = readAntigravityFixture('init.ndjson')[0] as string

/** `conversation_id` of every object in a line set to `id` (recorded lines carry the recording's). */
function retag(line: string, id: string): string {
  const walk = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(walk)
    if (!value || typeof value !== 'object') return value
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, k === 'conversation_id' ? id : walk(v)]),
    )
  }
  return JSON.stringify(walk(JSON.parse(line)))
}

const flag = (argv: string[], name: string) => {
  const at = argv.indexOf(name)
  return at < 0 ? null : (argv[at + 1] ?? null)
}

/**
 * Fake `agy -p` behind the guest process API: prints `init` when the process starts (a `--conversation` it
 * never created starts a new one, like the CLI) and plays `script` for each user line written to stdin.
 */
export class FakeAntigravityBackend implements GuestCliBackend {
  specs: GuestProcSpec[] = []
  /** User messages written to the processes, in order. */
  inputs: string[] = []
  signals: string[] = []
  /** Signals the process ignores (SIGINT ends the turn and the process, SIGTERM/SIGKILL the process). */
  ignoredSignals = new Set<string>()
  sessions = new Map<string, string | null>()
  files = new Map<string, string>()
  /** Lines longer than this reach stdout in pieces flagged `partial`, like the guest splits them. */
  splitLinesOver: number | null = null
  script: string[] = readAntigravityFixture('turn-tools.ndjson')
  /** Lines for the `n`th message written to a process (null: `script`). */
  scriptFor: ((procId: string, n: number) => string[] | null) | null = null
  private readonly conversations = new Map<string, string>()
  private readonly created = new Set<string>()
  private readonly writes = new Map<string, number>()
  private readonly listeners = new Map<string, (e: GuestProcEvent) => void>()
  private readonly backlog = new Map<string, GuestProcEvent[]>()
  private seq = 0

  async startProcess(spec: GuestProcSpec) {
    this.specs.push(spec)
    const id = `proc-${this.specs.length}`
    this.backlog.set(id, [])
    const asked = flag(spec.argv, '--conversation')
    const conversation = asked && this.created.has(asked) ? asked : `conv-${this.created.size + 1}`
    this.created.add(conversation)
    this.conversations.set(id, conversation)
    this.emitLine(id, retag(initLine, conversation))
    return { id }
  }

  /** Content of a file written with `writeAgentFile`, by the name it was given. */
  file(name: string): string | undefined {
    return this.files.get(name)
  }

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

  async writeStdin(procId: string, data: string) {
    for (const line of data.split('\n').filter(Boolean)) {
      const message = JSON.parse(line) as { message?: { content?: Array<{ text?: string }> } }
      this.inputs.push(message.message?.content?.[0]?.text ?? '')
      const n = (this.writes.get(procId) ?? 0) + 1
      this.writes.set(procId, n)
      const script = this.scriptFor?.(procId, n) ?? this.script
      const conversation = this.conversations.get(procId) as string
      setTimeout(() => {
        for (const out of script) this.emitLine(procId, retag(out, conversation))
      }, 1)
    }
  }

  async signal(procId: string, sig: string) {
    this.signals.push(sig)
    if (this.ignoredSignals.has(sig)) return
    setTimeout(() => {
      if (sig === 'SIGINT')
        this.emitLine(
          procId,
          JSON.stringify({
            event: 'result',
            result: { status: 'ERROR', response: '', error: 'interrupted' },
          }),
        )
      this.push(procId, { type: 'exit', code: sig === 'SIGKILL' ? null : 1, signal: null })
    }, 1)
  }

  async writeAgentFile(name: string, content: string) {
    this.files.set(name, content)
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
}

/** A step or result line in `agy`'s stream-json shape (for scripted turns). */
export const agyLine = {
  input: (index: number) =>
    JSON.stringify({
      event: 'step_update',
      step_update: { step_index: index, state: 'DONE', step_type: 'user_input' },
    }),
  answer: (index: number, text: string) =>
    JSON.stringify({
      event: 'step_update',
      step_update: {
        step_index: index,
        state: 'DONE',
        step_type: 'agent_response',
        text_delta: text,
        usage: { input_tokens: 1200, output_tokens: 20, thinking_tokens: 5, cache_read_tokens: 300 },
      },
    }),
  tool: (index: number, state: 'ACTIVE' | 'DONE', name: string, parameters: object, output?: string) =>
    JSON.stringify({
      event: 'step_update',
      step_update: {
        step_index: index,
        state,
        step_type: 'tool',
        tool_name: name,
        tool_info: { name, parameters, ...(output === undefined ? {} : { output }) },
      },
    }),
  result: (text: string, status = 'SUCCESS') =>
    JSON.stringify({ event: 'result', result: { status, response: text } }),
}
