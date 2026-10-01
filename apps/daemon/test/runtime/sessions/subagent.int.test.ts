import type { AgentHostOptions, DefaultAgentHost } from '@milibot/agent'
import type { ChatMessage, CompletionRequest } from '@milibot/agent/llm'
import type { FakeProvider, FakeStep } from '@milibot/agent/testing'
import type { ActivityPayload, Message, WorkSession, WorkspaceEvent } from '@milibot/shared'
import { afterEach, describe, expect, it } from 'vitest'

import type { WorkspaceRuntime } from '../../../src/runtime/runtime'
import type { QemuVmController } from '../../../src/runtime/vm/controller'
import type { FakeGuest } from '../../support/fake-guest'
import { bootRuntime, type RuntimeHarness, stopRuntimes } from '../../support/runtime-harness'
import { useTempDir } from '../../support/temp'
import { until } from '../../support/wait'

let h: RuntimeHarness
let runtime: WorkspaceRuntime
let host: DefaultAgentHost
let vm: QemuVmController
let events: WorkspaceEvent[]
let provider: FakeProvider
let guest: FakeGuest
let chiefDm: string

const dir = useTempDir('subagents')
afterEach(stopRuntimes)

const textOf = (message: ChatMessage | undefined) =>
  (message?.content ?? []).map((p) => (p.type === 'text' ? p.text : '')).join('\n')

function lastInput(request: CompletionRequest): { text: string; tools: number; system: string } {
  const index = request.messages.findLastIndex((m) => m.role === 'user')
  return {
    text: textOf(request.messages[index]),
    tools: request.messages.slice(index + 1).filter((m) => m.role === 'tool').length,
    system: textOf(request.messages[0]),
  }
}

const isHelper = (request: CompletionRequest) => lastInput(request).system.includes('# Helper task')
const inSession = (request: CompletionRequest) =>
  !isHelper(request) && lastInput(request).system.includes('# Work session')

async function boot(script: (request: CompletionRequest) => FakeStep, hostOptions: AgentHostOptions = {}) {
  h = await bootRuntime({ dir: dir(), script, host: { compaction: false, ...hostOptions } })
  ;({ runtime, host, events, provider, guest, dm: chiefDm } = h)
  vm = h.vm!
}

const call: RuntimeHarness['call'] = (...args) => h.call(...args)

const messagesOf = (conversationId: string): Message[] =>
  runtime.store.messages.list(conversationId, { limit: 200 }).messages

async function onlySession(): Promise<WorkSession> {
  await until(() => runtime.store.db.prepare('SELECT 1 FROM work_sessions').get() !== undefined)
  const [session] = await call<WorkSession[]>('listWorkSessions', {}, undefined, {})
  return session as WorkSession
}

/** Chat opens a session; the session asks two helpers at once, then finishes with what they reported. */
function script(helperStarts: number[]) {
  return (request: CompletionRequest): FakeStep => {
    const { text, tools } = lastInput(request)
    if (isHelper(request)) {
      const task = /Your task, from the work session "[^"]+":\n(.+)/.exec(text)?.[1] ?? '?'
      if (tools === 0) {
        helperStarts.push(Date.now())
        return { toolCalls: [{ name: 'grep', arguments: { pattern: task } }], delayMs: 120 }
      }
      return { text: `report on ${task}` }
    }
    if (inSession(request)) {
      if (tools === 0)
        return {
          toolCalls: [
            { name: 'subagent', arguments: { task: 'map routes', tools: 'read_only' } },
            { name: 'subagent', arguments: { task: 'read tests' } },
          ],
        }
      if (tools === 2)
        return { toolCalls: [{ name: 'session_finish', arguments: { summary: 'Done.', status: 'done' } }] }
      return { text: 'Closed.' }
    }
    if (text.includes('refactor') && tools === 0)
      return {
        toolCalls: [
          { name: 'session_start', arguments: { title: 'Refactor', goal: 'Swap the session for tokens.' } },
        ],
      }
    return { text: 'Ok.' }
  }
}

describe('helpers of a work session', () => {
  it('run in parallel in the session folder and their reports go back to the session', async () => {
    const starts: number[] = []
    await boot(script(starts))
    await call('postMessage', { conversationId: chiefDm }, { content: 'refactor the login' })
    const session = await onlySession()
    await host.idle()

    expect(starts).toHaveLength(2)
    expect(Math.abs((starts[1] as number) - (starts[0] as number))).toBeLessThan(100)
    const parent = provider.requests
      .filter(inSession)
      .find((r) => lastInput(r).tools === 2) as CompletionRequest
    const results = parent.messages.filter((m) => m.role === 'tool').map(textOf)
    expect(results).toEqual([
      'Helper report:\n\nreport on map routes',
      'Helper report:\n\nreport on read tests',
    ])
    const greps = guest.state.execs.filter((e) => (e.env as Record<string, string> | undefined)?.PATTERN)
    expect(greps.map((e) => e.cwd)).toEqual([session.cwd, session.cwd])
    expect(session.cwd).toMatch(/^\/workspace\/sessions\//)
    const helper = provider.requests.find((r) => isHelper(r) && lastInput(r).text.includes('map routes'))
    expect(helper?.tools.map((t) => t.name)).not.toContain('file_write')

    const sessionMessages = messagesOf(session.conversationId)
    expect(sessionMessages.filter((m) => m.kind === 'text').map((m) => m.content)).toEqual(['Closed.'])
    const activity = sessionMessages.find((m) => m.kind === 'activity')?.payload as ActivityPayload
    expect(activity.steps.filter((s) => s.kind === 'subtask').map((s) => s.result)).toEqual([
      'report on map routes',
      'report on read tests',
    ])
    const counts = events.flatMap((e) =>
      e.type === 'work_session.updated' && e.payload.session.subagents ? [e.payload.session.subagents] : [],
    )
    expect(counts.some((c) => c.running === 2)).toBe(true)
    expect(counts.at(-1)).toEqual({ running: 0, total: 2 })
    const detail = await call<WorkSession>('getWorkSession', { sessionId: session.id })
    expect(detail.status).toBe('done')
  })

  it('refuses helpers past the per-session limit', async () => {
    await boot(script([]), { maxSubagents: 1 })
    await call('postMessage', { conversationId: chiefDm }, { content: 'refactor the login' })
    await onlySession()
    await host.idle()
    const parent = provider.requests
      .filter(inSession)
      .find((r) => lastInput(r).tools === 2) as CompletionRequest
    const results = parent.messages.filter((m) => m.role === 'tool').map(textOf)
    expect(results[0]).toContain('report on map routes')
    expect(results[1]).toContain('already started its 1 helpers')
  })
})

describe('session folder', () => {
  it('keeps the planned folder when the VM is off at the start and makes it before the next turn', async () => {
    await boot((request) => {
      const { text, tools } = lastInput(request)
      if (inSession(request)) return { text: 'Ready.' }
      if (text.includes('refactor') && tools === 0)
        return {
          toolCalls: [{ name: 'session_start', arguments: { title: 'Refactor', goal: 'Swap the session.' } }],
        }
      return { text: 'Ok.' }
    })
    const realGuest = vm.guest.bind(vm)
    vm.guest = async () => {
      throw new Error('VM_UNAVAILABLE')
    }
    await call('postMessage', { conversationId: chiefDm }, { content: 'refactor the login' })
    const session = await onlySession()
    await host.idle()
    const planned = (await call<WorkSession>('getWorkSession', { sessionId: session.id })).cwd as string
    expect(planned).toMatch(/^\/workspace\/sessions\//)
    const brief = messagesOf(session.conversationId)[0]
    expect(brief?.content).toContain(planned)
    const mkdir = () => guest.state.execs.filter((e) => String(e.cmd).includes('mkdir -p "$SESSION_DIR"'))
    expect(mkdir()).toHaveLength(0)

    vm.guest = realGuest
    await call('postMessage', { conversationId: session.conversationId }, { content: 'continue' })
    await host.idle()
    expect(mkdir().map((e) => (e.env as Record<string, string>).SESSION_DIR)).toEqual([planned])
    expect((await call<WorkSession>('getWorkSession', { sessionId: session.id })).cwd).toBe(planned)
  })
})
