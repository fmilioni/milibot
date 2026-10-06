import { describe, expect, it } from 'vitest'

import { FakeProvider, type FakeStep } from '../llm/fake'
import type { ChatMessage } from '../llm/messages'
import type { CompletionRequest } from '../llm/provider'
import { makeBot, TestEnv } from '../test-support/env'
import { DefaultAgentHost } from './agent-host'
import { sessionLaneKey } from './lanes'

const SESSION = 'wses_01STATUSSESSION'

/** `tool:<name>` calls that tool once, then the turn answers. */
function script(request: CompletionRequest): FakeStep {
  const messages = request.messages as ChatMessage[]
  const index = messages.findLastIndex((m) => m.role === 'user')
  const text = (messages[index]?.content ?? []).map((p) => (p.type === 'text' ? p.text : '')).join('\n')
  const afterTool = messages.slice(index + 1).some((m) => m.role === 'tool')
  const tool = /tool:(\w+)/.exec(text)?.[1]
  if (tool && !afterTool) return { toolCalls: [{ name: tool, arguments: { command: 'in turn' } }] }
  return { text: 'done' }
}

interface Gate {
  promise: Promise<void>
  release(): void
  started: boolean
}

function newGate(): Gate {
  let release = () => undefined as void
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { promise, release: () => release(), started: false }
}

async function setup() {
  const env = new TestEnv(new FakeProvider({ script }))
  const bot = makeBot()
  const chat = env.addBot(bot)
  const session = env.addBot(bot)
  env.sessions.set(session.id, SESSION)
  /**
   * Bash commands that block until their gate opens; `detached` gates then wait again without the turn's
   * slot, until their own gate opens.
   */
  const gates = new Map<string, Gate & { detached?: Gate }>()
  env.toolHandler = async (ctx, call) => {
    const command = (call.arguments as { command?: string } | null)?.command ?? ''
    const g = gates.get(command)
    if (g) {
      g.started = true
      await g.promise
      if (g.detached) {
        g.detached.started = true
        await ctx.detach?.(g.detached.promise)
      }
    }
    return { content: [{ type: 'text', text: `ran ${call.name}` }] }
  }
  const host = new DefaultAgentHost({ deltaFlushMs: 1 })
  await host.start(env)
  const say = (conversationId: string, text: string) =>
    host.onMessageCreated(env.userMessage(conversationId, text))
  const lastStatus = () => env.statuses.filter((s) => s.botId === bot.id).at(-1)
  const sessionLane = sessionLaneKey(bot.id, SESSION)
  /** A Milibot tool call over MCP from the session lane's CLI process (no conversation of its own). */
  const mcpCall = (command: string) =>
    host.runTool(bot.id, null, { id: `mcp_${command}`, name: 'bash', arguments: { command } }, sessionLane)
  return { env, bot, chat, session, host, gates, say, lastStatus, sessionLane, mcpCall }
}

const until = async (check: () => boolean, timeoutMs = 2000) => {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) throw new Error('condition not met in time')
    await new Promise((r) => setTimeout(r, 5))
  }
}

describe('bot status once no lane works', () => {
  it('stays available after a tool call reaches a session lane that already closed', async () => {
    const { bot, chat, session, host, say, lastStatus, sessionLane, mcpCall } = await setup()
    say(session.id, 'tool:bash')
    await host.idle(bot.id)
    await host.closeLane(sessionLane)

    const late = await mcpCall('late')
    expect(late.isError).toBe(true)
    expect(lastStatus()).toEqual({ botId: bot.id, status: 'idle' })

    say(chat.id, 'hi')
    await host.idle(bot.id)
    expect(lastStatus()).toEqual({ botId: bot.id, status: 'idle' })
  })

  it('goes back to available after a tool call that came between turns of a lane', async () => {
    const { bot, chat, session, host, say, lastStatus, mcpCall } = await setup()
    say(session.id, 'hi')
    await host.idle(bot.id)

    const between = await mcpCall('between turns')
    expect(between.isError).toBeFalsy()
    expect(lastStatus()).toEqual({ botId: bot.id, status: 'idle' })

    say(chat.id, 'hi')
    await host.idle(bot.id)
    expect(lastStatus()).toEqual({ botId: bot.id, status: 'idle' })
  })

  it('goes back to available when a wait outlives the turn of its tool call', async () => {
    const { bot, chat, session, host, gates, say, lastStatus, mcpCall } = await setup()
    const turnTool = newGate()
    gates.set('in turn', turnTool)
    say(session.id, 'tool:bash')
    await until(() => turnTool.started)

    // The CLI's MCP call joins the running turn, which ends before the call starts waiting.
    const waiting = newGate()
    const before = { ...newGate(), detached: waiting }
    gates.set('slow', before)
    const call = mcpCall('slow')
    await until(() => before.started)
    turnTool.release()
    await host.idle(bot.id)
    before.release()
    await until(() => waiting.started)
    waiting.release()
    await call
    expect(lastStatus()).toEqual({ botId: bot.id, status: 'idle' })

    say(chat.id, 'hi')
    await host.idle(bot.id)
    expect(lastStatus()).toEqual({ botId: bot.id, status: 'idle' })
  })

  it('goes back to available when the session lane it showed closes', async () => {
    const { bot, session, host, say, lastStatus, sessionLane } = await setup()
    host.hold(true)
    say(session.id, 'queued while held')
    expect(lastStatus()).toMatchObject({ status: 'thinking', sessionId: SESSION })

    // The session was deleted: its queued request is dropped with the lane.
    await host.closeLane(sessionLane)
    expect(lastStatus()).toEqual({ botId: bot.id, status: 'idle' })
    host.hold(false)
    await host.idle(bot.id)
    expect(lastStatus()).toEqual({ botId: bot.id, status: 'idle' })
  })

  it('stays available when the session lane closes as its last turn ends', async () => {
    const { env, bot, chat, session, host, say, lastStatus, sessionLane, mcpCall } = await setup()
    env.turnFinished = (info) => {
      if (info.conversationId === session.id) void host.closeLane(sessionLane)
    }
    say(session.id, 'tool:bash')
    await host.idle(bot.id)
    await new Promise((r) => setTimeout(r, 10))

    const late = await mcpCall('late')
    expect(late.isError).toBe(true)
    say(chat.id, 'hi')
    await host.idle(bot.id)
    expect(lastStatus()).toEqual({ botId: bot.id, status: 'idle' })
  })
})
