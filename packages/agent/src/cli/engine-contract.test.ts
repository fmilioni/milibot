import type { CliEngine } from '@milibot/shared'
import { describe, expect, it } from 'vitest'

import { agyLine, FakeAntigravityBackend, readAntigravityFixture } from '../test-support/antigravity'
import { FakeBackend, turnFixture } from '../test-support/claude-code'
import { FakeCodexBackend, readCodexFixture } from '../test-support/codex'
import { makeBot } from '../test-support/env'
import type { GuestCliBackend, GuestProcSpec } from './backend'
import type { CliLaunch, CliSessions, CliTurnIO } from './engine'
import type { CliTiming } from './process'
import { CLI_ENGINE_DRIVERS } from './registry'
import type { CliStartup } from './startup'

type Fake = GuestCliBackend & {
  specs: GuestProcSpec[]
  signals: string[]
  sessions: Map<string, string | null>
  ignoredSignals: Set<string>
  push(procId: string, event: { type: string; [key: string]: unknown }): void
}

/** How each engine's fake plays the situations every engine must handle. */
interface Harness<B extends Fake> {
  engine: CliEngine
  backend(): B
  create(backend: B, timing: CliTiming): CliSessions
  /** Text of the scripted turn. */
  answer: string
  /** The next turn runs until it is interrupted. */
  hang(backend: B): void
  /** ...and ignores the interrupt. */
  ignoreInterrupt(backend: B): void
  /** The stored session `id` no longer exists when the next process resumes it. */
  loseSession(backend: B, id: string): void
  /** The next turn takes in `text` sent while it runs, then answers `MID_TURN_ANSWER`. */
  takeMidTurn(backend: B, text: string): void
  /** The process exits with code 1 during the next turn. */
  exitMidTurn(backend: B): void
  /** Stdout lines longer than 100 characters arrive in pieces. */
  splitLines(backend: B): void
  /** The next turn edits a file with a native tool (null: the engine reports no per-step diffs). */
  editFile: ((backend: B) => void) | null
  /** The next one-shot answers `text`. */
  answerOneShot(backend: B, text: string): void
}

const MID_TURN_ANSWER = 'Answered both.'

const line = (value: unknown) => JSON.stringify(value)
const claudeInit = line({ type: 'system', subtype: 'init', session_id: 'sess-new', mcp_servers: [] })
const claudeResult = (text: string) =>
  line({ type: 'result', subtype: 'success', is_error: false, result: text, session_id: 'sess-new' })

const claudeCode: Harness<FakeBackend> = {
  engine: 'claude_code',
  backend: () => new FakeBackend(),
  create: (backend, timing) => CLI_ENGINE_DRIVERS.claude_code.createSessions(backend, undefined, timing),
  answer: 'The folder is empty.',
  hang: (backend) => {
    backend.script = turnFixture.slice(0, 3)
  },
  ignoreInterrupt: (backend) => backend.ignoredSignals.add('SIGINT'),
  loseSession: (backend, id) => {
    backend.scriptFor = (procId) =>
      procId === 'proc-1'
        ? [
            line({
              type: 'result',
              subtype: 'error_during_execution',
              is_error: true,
              errors: [`No conversation found with session ID: ${id}`],
            }),
          ]
        : null
  },
  takeMidTurn: (backend, text) => {
    let writes = 0
    backend.scriptFor = () =>
      ++writes === 1
        ? [
            claudeInit,
            line({
              type: 'assistant',
              message: {
                id: 'm1',
                role: 'assistant',
                content: [{ type: 'tool_use', id: 't1', name: 'Bash' }],
              },
            }),
          ]
        : [
            line({
              type: 'user',
              message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
            }),
            line({
              type: 'user',
              message: { role: 'user', content: [{ type: 'text', text }] },
              isReplay: true,
            }),
            line({
              type: 'assistant',
              message: { id: 'm2', role: 'assistant', content: [{ type: 'text', text: MID_TURN_ANSWER }] },
            }),
            claudeResult(MID_TURN_ANSWER),
          ]
  },
  exitMidTurn: (backend) => {
    backend.scriptFor = (procId) => {
      setTimeout(() => backend.push(procId, { type: 'exit', code: 1, signal: null }), 5)
      return [claudeInit]
    }
  },
  splitLines: (backend) => {
    backend.splitLinesOver = 100
  },
  editFile: (backend) => {
    backend.script = [
      claudeInit,
      line({
        type: 'assistant',
        message: {
          id: 'm1',
          role: 'assistant',
          content: [{ type: 'tool_use', id: 't1', name: 'Edit', input: { file_path: '/workspace/a.ts' } }],
        },
      }),
      line({
        type: 'user',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'done' }] },
        tool_use_result: {
          filePath: '/workspace/a.ts',
          structuredPatch: [
            { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-x = 1', '+x = 2'] },
          ],
        },
      }),
      claudeResult('Edited.'),
    ]
  },
  answerOneShot: (backend, text) => {
    backend.scriptFor = (procId) => {
      setTimeout(() => backend.push(procId, { type: 'exit', code: 0, signal: null }), 5)
      return [claudeResult(text)]
    }
  },
}

const codex: Harness<FakeCodexBackend> = {
  engine: 'codex',
  backend: () => new FakeCodexBackend(),
  create: (backend, timing) => CLI_ENGINE_DRIVERS.codex.createSessions(backend, undefined, timing),
  answer: 'All done.',
  hang: (backend) => {
    const script = readCodexFixture('turn-interrupt.ndjson')
    const completed = script.pop() as { params: { turn: Record<string, unknown> } }
    backend.turnScripts = [script]
    backend.handlers['turn/interrupt'] = (req) => {
      setTimeout(
        () =>
          backend.emit(req.procId, {
            method: 'turn/completed',
            params: {
              threadId: req.params.threadId,
              turn: { ...completed.params.turn, id: req.params.turnId },
            },
          }),
        5,
      )
      return { result: {} }
    }
  },
  ignoreInterrupt: (backend) => {
    delete backend.handlers['turn/interrupt']
  },
  loseSession: (backend, id) => {
    backend.handlers['thread/resume'] = () => ({
      error: { code: -32600, message: `no rollout found for thread id ${id}` },
    })
  },
  takeMidTurn: (backend) => {
    const recorded = readCodexFixture('turn-steer.ndjson')
    const split =
      recorded.findIndex(
        (m) => m.method === 'item/started' && JSON.stringify(m).includes('commandExecution'),
      ) + 1
    backend.turnScripts = [recorded.slice(0, split)]
    backend.handlers['turn/steer'] = (req) => {
      setTimeout(() => {
        backend.play(
          req.procId,
          req.params.threadId as string,
          req.params.expectedTurnId as string,
          recorded.slice(split),
          req.params.clientUserMessageId as string,
        )
      }, 1)
      return undefined
    }
  },
  exitMidTurn: (backend) => {
    backend.turnScripts = [[]]
    backend.handlers['turn/start'] = (req) => {
      setTimeout(() => backend.push(req.procId, { type: 'exit', code: 1, signal: null }), 5)
      return undefined
    }
  },
  splitLines: (backend) => {
    const emit = backend.emit.bind(backend)
    backend.emit = (procId, message) => {
      const text = JSON.stringify(message)
      if (text.length <= 100) return emit(procId, message)
      for (let at = 0; at < text.length; at += 100)
        backend.push(procId, {
          type: 'stdout',
          data: text.slice(at, at + 100),
          partial: at + 100 < text.length,
        })
    }
  },
  editFile: () => undefined,
  answerOneShot: (backend, text) => {
    const params = { threadId: 't', turnId: 'x' }
    backend.turnScripts = [
      [
        { method: 'item/completed', params: { ...params, item: { type: 'agentMessage', id: 'm', text } } },
        {
          method: 'turn/completed',
          params: { threadId: 't', turn: { id: 'x', status: 'completed', error: null, durationMs: 12 } },
        },
      ],
    ]
  },
}

const antigravity: Harness<FakeAntigravityBackend> = {
  engine: 'antigravity',
  backend: () => new FakeAntigravityBackend(),
  create: (backend, timing) => CLI_ENGINE_DRIVERS.antigravity.createSessions(backend, undefined, timing),
  answer: '2',
  hang: (backend) => {
    const recorded = readAntigravityFixture('turn-tools.ndjson')
    backend.script = recorded.slice(0, recorded.findIndex((l) => l.includes('"ACTIVE"')) + 1)
  },
  ignoreInterrupt: (backend) => backend.ignoredSignals.add('SIGINT'),
  // The fake resumes only conversations it started: any other id is lost.
  loseSession: () => undefined,
  takeMidTurn: (backend) => {
    const command = { CommandLine: 'sleep 5' }
    backend.scriptFor = (_procId, n) =>
      n === 1
        ? [agyLine.input(0), agyLine.answer(1, ''), agyLine.tool(2, 'ACTIVE', 'run_command', command)]
        : [
            agyLine.tool(2, 'DONE', 'run_command', command, ''),
            agyLine.answer(3, 'Done.'),
            agyLine.result('Done.'),
            agyLine.input(4),
            agyLine.answer(5, MID_TURN_ANSWER),
            agyLine.result(MID_TURN_ANSWER),
          ]
  },
  exitMidTurn: (backend) => {
    backend.scriptFor = (procId) => {
      setTimeout(() => backend.push(procId, { type: 'exit', code: 1, signal: null }), 5)
      return []
    }
  },
  splitLines: (backend) => {
    backend.splitLinesOver = 100
  },
  // agy's tool events carry no file contents.
  editFile: null,
  answerOneShot: (backend, text) => {
    backend.scriptFor = (procId) => {
      setTimeout(() => backend.push(procId, { type: 'exit', code: 0, signal: null }), 5)
      return [agyLine.input(0), agyLine.answer(1, text), agyLine.result(text)]
    }
  },
}

const fast: CliTiming = { interruptGraceMs: 40, killGraceMs: 40 }
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
const bot = makeBot({ slug: 'iris', displayNum: 3 })
const other = makeBot({ slug: 'noa', displayNum: 4 })

function recorder(signal = new AbortController().signal) {
  const text: string[] = []
  const tools: string[] = []
  let taken = 0
  const io: CliTurnIO = {
    signal,
    onTextDelta: (delta) => text.push(delta),
    onTextBoundary: () => undefined,
    onNativeToolStart: (id) => tools.push(`start:${id}`),
    onNativeToolFinish: (id, isError) => tools.push(`finish:${id}:${isError}`),
    onInputTaken: () => taken++,
  }
  return { io, text, tools, taken: () => taken }
}

function launch(extra: Partial<CliLaunch> = {}): CliLaunch {
  return { bot, model: null, env: {}, idleTimeoutMs: 60_000, instructions: 'You are Iris.', ...extra }
}

function startups(calls: boolean[]): (fresh: boolean) => CliStartup {
  return (fresh) => {
    calls.push(fresh)
    return {
      systemAppendix: fresh ? 'MEMORY' : '',
      inputPrefix: fresh ? null : 'news',
      sections: { longTermMemory: 1, summaries: 0, recap: 0 },
    }
  }
}

describe.each([claudeCode, codex, antigravity] as unknown as Array<Harness<Fake>>)(
  'CLI engine contract: $engine',
  (h) => {
    const setup = () => {
      const backend = h.backend()
      return { backend, sessions: h.create(backend, fast) }
    }

    it('runs a fresh turn, stores its session and reuses the process for the next one', async () => {
      const { backend, sessions } = setup()
      const calls: boolean[] = []
      const { io, text, tools } = recorder()
      const first = await sessions.runTurn(launch({ startup: startups(calls) }), 'hi', io)
      expect(first).toMatchObject({ ok: true, text: h.answer, error: null })
      expect(first.launched?.fresh).toBe(true)
      expect(calls).toEqual([true])
      expect(text.join('')).toContain(h.answer)
      expect(tools.filter((t) => t.startsWith('finish:')).length).toBeGreaterThan(0)
      expect(first.requests).toBeGreaterThan(0)
      expect(first.usage).not.toBeNull()
      expect(first.billing.usage.costSource).not.toBe('unknown')
      expect(first.sessionId).not.toBeNull()
      expect(sessions.storedSessionId(bot.id)).toBe(first.sessionId)
      expect(backend.specs[0]).toMatchObject({ user: 'agent', display: 3, bot: 'iris' })

      const second = await sessions.runTurn(launch({ startup: startups(calls) }), 'again', recorder().io)
      expect(second.ok).toBe(true)
      expect(second.launched).toBeNull()
      expect(backend.specs).toHaveLength(1)
      expect(sessions.activeLanes()).toEqual([bot.id])
      await sessions.closeAll()
    })

    it('resumes the stored session in a new process', async () => {
      const { backend, sessions } = setup()
      const first = await sessions.runTurn(launch(), 'hi', recorder().io)
      await sessions.close(bot.id)
      const calls: boolean[] = []
      const resumed = await sessions.runTurn(launch({ startup: startups(calls) }), 'again', recorder().io)
      expect(resumed.ok).toBe(true)
      expect(resumed.launched?.fresh).toBe(false)
      expect(calls).toEqual([false])
      expect(backend.specs).toHaveLength(2)
      expect(sessions.storedSessionId(bot.id)).toBe(first.sessionId)
      await sessions.closeAll()
    })

    it('starts over with the memory recap when the stored session is gone', async () => {
      const { sessions, backend } = setup()
      backend.sessions.set(bot.id, 'lost-session')
      h.loseSession(backend, 'lost-session')
      const calls: boolean[] = []
      const result = await sessions.runTurn(launch({ startup: startups(calls) }), 'hi', recorder().io)
      expect(result).toMatchObject({ ok: true, text: h.answer })
      expect(result.launched?.fresh).toBe(true)
      expect(calls).toEqual([false, true])
      expect(sessions.storedSessionId(bot.id)).not.toBe('lost-session')
      expect(sessions.storedSessionId(bot.id)).toBe(result.sessionId)
      await sessions.closeAll()
    })

    it('interrupts a running turn when the Milibot turn is stopped', async () => {
      const { sessions, backend } = setup()
      h.hang(backend)
      const abort = new AbortController()
      const pending = sessions.runTurn(launch(), 'run forever', recorder(abort.signal).io)
      await wait(15)
      abort.abort()
      expect(await pending).toMatchObject({ ok: false, subtype: 'interrupted', error: null })
      expect(backend.signals).not.toContain('SIGKILL')
      await sessions.closeAll()
    })

    it('interrupts a turn stopped before its process was ready', async () => {
      const { sessions, backend } = setup()
      h.hang(backend)
      const abort = new AbortController()
      abort.abort()
      const result = await sessions.runTurn(launch(), 'run forever', recorder(abort.signal).io)
      expect(result).toMatchObject({ ok: false, subtype: 'interrupted', error: null })
      await sessions.closeAll()
    })

    it('kills a process that ignores the interrupt', async () => {
      const { sessions, backend } = setup()
      h.hang(backend)
      h.ignoreInterrupt(backend)
      const abort = new AbortController()
      const pending = sessions.runTurn(launch(), 'run forever', recorder(abort.signal).io)
      await wait(15)
      abort.abort()
      expect(await pending).toMatchObject({ ok: false, subtype: 'interrupted', error: null })
      expect(backend.signals).toContain('SIGKILL')
      expect(sessions.activeLanes()).toEqual([])
    })

    it('hands a message sent mid-turn to the running turn', async () => {
      const { sessions, backend } = setup()
      h.takeMidTurn(backend, 'also: say hi')
      const rec = recorder()
      let accepted: boolean | null = null
      rec.io.onAcceptingInput = (send) => {
        accepted = send('also: say hi')
      }
      const result = await sessions.runTurn(launch(), 'run the slow thing', rec.io)
      expect(accepted).toBe(true)
      expect(rec.taken()).toBe(1)
      expect(result).toMatchObject({ ok: true, text: MID_TURN_ANSWER })
      await sessions.closeAll()
    })

    it('refuses messages once the turn is over', async () => {
      const { sessions } = setup()
      const rec = recorder()
      let send: ((text: string) => boolean) | null = null
      rec.io.onAcceptingInput = (s) => (send = s)
      await sessions.runTurn(launch(), 'hi', rec.io)
      expect(send).not.toBeNull()
      expect((send as unknown as (text: string) => boolean)('too late')).toBe(false)
      await sessions.closeAll()
    })

    it('reports a process that exits mid-turn as a failed turn', async () => {
      const { sessions, backend } = setup()
      h.exitMidTurn(backend)
      const result = await sessions.runTurn(launch(), 'hi', recorder().io)
      expect(result).toMatchObject({ ok: false, subtype: 'process_exited' })
      expect(result.error?.code).toBe('cli_error')
      expect(result.error?.message).toMatch(/exited \(code 1/)
      expect(sessions.activeLanes()).toEqual([])
    })

    it('reports a process that cannot start as a failed turn', async () => {
      const { sessions, backend } = setup()
      backend.startProcess = async () => {
        throw new Error('VM_UNAVAILABLE')
      }
      const result = await sessions.runTurn(launch(), 'hi', recorder().io)
      expect(result).toMatchObject({ ok: false, launched: null })
      expect(result.error?.code).toBe('cli_error')
      expect(result.error?.message).toMatch(/VM_UNAVAILABLE/)
      expect(sessions.activeLanes()).toEqual([])
    })

    it('joins stdout lines the guest split', async () => {
      const { sessions, backend } = setup()
      h.splitLines(backend)
      const result = await sessions.runTurn(launch(), 'hi', recorder().io)
      expect(result).toMatchObject({ ok: true, text: h.answer })
      await sessions.closeAll()
    })

    it('closes one lane, a bot’s lanes or every lane, and rotates a lane’s session', async () => {
      const { sessions, backend } = setup()
      const internal = `${bot.id}:internal`
      await sessions.runTurn(launch(), 'hi', recorder().io)
      await sessions.runTurn(launch({ key: internal }), 'hi', recorder().io)
      await sessions.runTurn(launch({ bot: other }), 'hi', recorder().io)
      expect(backend.specs.map((s) => s.label)).toEqual([
        expect.stringMatching(/:iris$/),
        expect.stringMatching(/:iris:internal$/),
        expect.stringMatching(/:noa$/),
      ])
      expect(sessions.activeLanes().sort()).toEqual([bot.id, internal, other.id].sort())

      await sessions.close(internal)
      expect(sessions.activeLanes().sort()).toEqual([bot.id, other.id].sort())
      expect(backend.signals).toEqual(['SIGTERM'])
      expect(sessions.storedSessionId(internal)).not.toBeNull()

      await sessions.rotate(internal)
      expect(sessions.storedSessionId(internal)).toBeNull()

      await sessions.closeBot(bot.id)
      expect(sessions.activeLanes()).toEqual([other.id])
      await sessions.closeAll()
      expect(sessions.activeLanes()).toEqual([])
      expect(sessions.storedSessionId(other.id)).not.toBeNull()
    })

    it.runIf(h.editFile)('reports the files a native tool changed', async () => {
      const { sessions, backend } = setup()
      h.editFile?.(backend)
      const edits: string[] = []
      const rec = recorder()
      rec.io.onNativeToolFinish = (_id, isError, _output, diffs) => {
        if (!isError) edits.push(...diffs.map((d) => `${d.status} ${d.path}`))
      }
      const result = await sessions.runTurn(launch(), 'edit it', rec.io)
      expect(result.ok).toBe(true)
      expect(edits.length).toBeGreaterThan(0)
      expect(edits.every((e) => /^(added|modified) \/workspace\//.test(e))).toBe(true)
      await sessions.closeAll()
    })

    it('answers a one-shot in a process of its own, labelled for the orphan sweep', async () => {
      const { sessions, backend } = setup()
      h.answerOneShot(backend, 'Short summary.')
      const result = await sessions.oneShot({
        bot,
        model: null,
        env: {},
        systemPrompt: 'Summarize.',
        prompt: 'long text',
        label: 'draw',
      })
      expect(result).toMatchObject({ text: 'Short summary.', error: null })
      expect(backend.specs[0]?.label).toBe(`${CLI_ENGINE_DRIVERS[h.engine].procLabel}-draw:iris`)
      expect(sessions.activeLanes()).toEqual([])
    })

    it('closes an idle process after its timeout', async () => {
      const { sessions, backend } = setup()
      await sessions.runTurn(launch({ idleTimeoutMs: 20 }), 'hi', recorder().io)
      expect(sessions.activeLanes()).toEqual([bot.id])
      await wait(40)
      expect(sessions.activeLanes()).toEqual([])
      expect(backend.signals).toEqual(['SIGTERM'])
    })
  },
)
