import type { DefaultAgentHost } from '@milibot/agent'
import type { CompletionRequest } from '@milibot/agent/llm'
import { PROCEDURE_SYSTEM_PROMPT } from '@milibot/agent/prompts'
import type { FakeStep } from '@milibot/agent/testing'
import type {
  ConversationDebug,
  LlmCallRow,
  Message,
  Procedure,
  TeachScreenshotResult,
  ToolCallRow,
  WorkspaceEvent,
} from '@milibot/shared'
import { afterEach, describe, expect, it } from 'vitest'

import type { WorkspaceRuntime } from '../../../src/runtime/runtime'
import { bootRuntime, type RuntimeHarness, stopRuntimes } from '../../support/runtime-harness'
import { useTempDir } from '../../support/temp'

let h: RuntimeHarness
let runtime: WorkspaceRuntime
let host: DefaultAgentHost
let events: WorkspaceEvent[]
let chiefId: string
let chiefDm: string
let requests: CompletionRequest[]

const dir = useTempDir('procedures')
afterEach(stopRuntimes)

// The accented "résumé" keeps the slug and name folding of skill lookups covered.
const PROCEDURE = JSON.stringify({
  goal: 'Export the résumé as PDF',
  preconditions: ['Résumé open in Writer'],
  parameters: [{ name: 'file_name', description: 'File name', example: 'resume-2026-09' }],
  steps: [
    { recorded: 1, kind: 'click', instruction: 'Open the File menu', target: 'Menu "File"' },
    { recorded: 2, kind: 'type', instruction: 'Type the file name', value: '{{file_name}}' },
    { recorded: 3, kind: 'key', instruction: 'Save', value: 'ctrl+s' },
  ],
})

async function boot(turn: (request: CompletionRequest, i: number) => FakeStep) {
  requests = []
  let turns = 0
  h = await bootRuntime({
    dir: dir(),
    script: (request) => {
      requests.push(request)
      const system = request.messages[0]?.content.map((p) => (p.type === 'text' ? p.text : '')).join('') ?? ''
      if (system.startsWith(PROCEDURE_SYSTEM_PROMPT.slice(0, 40))) return { text: PROCEDURE }
      if (request.tools.length === 0) return { text: 'Hi!' }
      return turn(request, turns++)
    },
  })
  ;({ runtime, host, events, botId: chiefId, dm: chiefDm } = h)
  await host.idle()
}

const call: RuntimeHarness['call'] = (...args) => h.call(...args)

async function messages(): Promise<Message[]> {
  return (
    await call<{ messages: Message[] }>('listMessages', { conversationId: chiefDm }, undefined, {
      limit: 100,
    })
  ).messages
}

async function teach(): Promise<Procedure> {
  const started = await call<Procedure>(
    'startTeach',
    { botId: chiefId },
    { conversationId: chiefDm, name: 'Export PDF' },
  )
  const shot = await call<TeachScreenshotResult>(
    'teachScreenshot',
    { procedureId: started.id },
    { x: 148, y: 92 },
  )
  await call<Procedure>(
    'finishTeach',
    { procedureId: started.id },
    {
      name: 'Export résumé as PDF',
      scope: 'bot',
      language: 'en',
      steps: [
        { kind: 'click', at: 1, x: 148, y: 92, screenshotSha: shot.sha256, narration: 'Writer menu' },
        { kind: 'type', at: 2, text: 'resume-2026-09' },
        { kind: 'key', at: 3, keys: 'ctrl+s' },
      ],
    },
  )
  await runtime.services.procedures.idle()
  return call<Procedure>('getProcedure', { procedureId: started.id })
}

describe('teach mode and procedures', () => {
  it('records, writes the procedure with the model and announces it in the chat', async () => {
    await boot(() => ({ text: 'ok' }))
    const started = await call<Procedure>(
      'startTeach',
      { botId: chiefId },
      { conversationId: chiefDm, name: 'Export PDF' },
    )
    expect(started.status).toBe('recording')
    expect(await call<Procedure[]>('listProcedures')).toEqual([])
    const line = (await messages()).at(-1)
    expect(line?.payload).toMatchObject({
      type: 'system',
      event: 'teach_started',
      params: { procedureName: 'Export PDF' },
    })
    await call('deleteProcedure', { procedureId: started.id })

    const procedure = await teach()
    expect(procedure).toMatchObject({
      status: 'ready',
      scope: 'bot',
      botId: chiefId,
      taughtByBotId: chiefId,
      goal: 'Export the résumé as PDF',
      preconditions: ['Résumé open in Writer'],
      error: null,
    })
    expect(procedure.steps.map((s) => [s.kind, s.instruction, s.value, s.x, s.narration])).toEqual([
      ['click', 'Open the File menu', null, 148, 'Writer menu'],
      ['type', 'Type the file name', '{{file_name}}', null, null],
      ['key', 'Save', 'ctrl+s', null, null],
    ])
    expect(procedure.steps[0]?.screenshotSha).toMatch(/^[0-9a-f]{64}$/)

    const procedureRequest = requests.find((r) =>
      r.messages[0]?.content.some((p) => p.type === 'text' && p.text.includes('reusable procedure')),
    )
    const images = procedureRequest?.messages[1]?.content.filter((p) => p.type === 'image') ?? []
    expect(images).toHaveLength(1)
    expect(images[0]).toMatchObject({ width: 1280, height: 800 })
    expect(images[0]?.type === 'image' && images[0].sha256).not.toBe(procedure.steps[0]?.screenshotSha)

    const card = (await messages()).at(-1)
    expect(card?.payload).toMatchObject({
      type: 'procedure_saved',
      name: 'Export résumé as PDF',
      steps: 3,
    })
    expect(events.some((e) => e.type === 'procedure.updated' && e.payload.procedure.status === 'ready')).toBe(
      true,
    )

    const debug = await call<ConversationDebug>('getConversationDebug', { conversationId: chiefDm })
    expect(debug.byModel.length).toBeGreaterThan(0)
    const calls = await call<LlmCallRow[]>('listLlmCalls', { conversationId: chiefDm }, undefined, {
      payloads: 'false',
    })
    const procedureCall = calls.find((c) => c.purpose === 'procedure')
    expect(procedureCall?.request).toBeNull()
    const full = await call<LlmCallRow>('getLlmCall', { callId: procedureCall?.id ?? '' })
    expect(JSON.stringify(full.request)).toContain('"type":"image"')
    expect(full.contextComposition?.imageCount).toBe(1)
  })

  it('removes the "you started teaching" line when the recording is discarded', async () => {
    await boot(() => ({ text: 'ok' }))
    const teachLines = async () =>
      (await messages()).filter((m) => m.payload?.type === 'system' && m.payload.event === 'teach_started')
    const started = await call<Procedure>(
      'startTeach',
      { botId: chiefId },
      { conversationId: chiefDm, name: 'Discarded' },
    )
    const [line] = await teachLines()
    expect(line).toBeDefined()
    events.length = 0
    await call('deleteProcedure', { procedureId: started.id })
    expect(await teachLines()).toEqual([])
    expect(events).toContainEqual({
      type: 'message.deleted',
      payload: { conversationId: chiefDm, messageId: line?.id },
    })
    expect(
      events.some((e) => e.type === 'conversation.updated' && e.payload.conversation.id === chiefDm),
    ).toBe(true)

    // A procedure that was taught keeps its line, even after the procedure itself is deleted.
    const procedure = await teach()
    await call('deleteProcedure', { procedureId: procedure.id })
    expect(await teachLines()).toHaveLength(1)
  })

  it('keeps the recording when the model answer is unusable', async () => {
    await boot(() => ({ text: 'ok' }))
    const started = await call<Procedure>(
      'startTeach',
      { botId: chiefId },
      { conversationId: chiefDm, name: '' },
    )
    runtime.services.procedures['deps'].host = {
      ...host,
      writeText: async () => ({ text: 'sorry, no json', llmCallId: null }),
    } as unknown as DefaultAgentHost
    await call(
      'finishTeach',
      { procedureId: started.id },
      { name: 'Open terminal', language: 'en', steps: [{ kind: 'key', at: 1, keys: 'ctrl+alt+t' }] },
    )
    await runtime.services.procedures.idle()
    const procedure = await call<Procedure>('getProcedure', { procedureId: started.id })
    expect(procedure.status).toBe('ready')
    expect(procedure.error).toMatch(/could not be read/)
    expect(procedure.steps.map((s) => [s.instruction, s.value])).toEqual([['Press ctrl+alt+t', 'ctrl+alt+t']])
  })

  it('offers taught procedures as skills the bots load and read, edits and deletes them', async () => {
    await boot(
      (_request, i) =>
        [
          { toolCalls: [{ name: 'skill_load', arguments: { name: 'export-resume-as-pdf' } }] },
          {
            toolCalls: [
              { name: 'skill_read', arguments: { name: 'Export résumé as PDF', path: 'step-1.png' } },
            ],
          },
          { toolCalls: [{ name: 'skill_load', arguments: { name: 'none of these' } }] },
          { text: 'Done.' },
        ][i] ?? { text: 'Done.' },
    )
    const procedure = await teach()
    await call('postMessage', { conversationId: chiefDm }, { content: 'export the résumé' })
    await host.idle()

    const system = requests
      .at(-1)
      ?.messages[0]?.content.map((p) => (p.type === 'text' ? p.text : ''))
      .join('')
    expect(system).toContain(
      '- export-resume-as-pdf — Taught by the user on the screen: Export the résumé as PDF',
    )
    const tools = await call<ToolCallRow[]>('listToolCalls', { conversationId: chiefDm }, undefined, {
      limit: 20,
    })
    const [load, read, missing] = tools
    expect(load?.toolName).toBe('skill_load')
    expect(load?.status).toBe('ok')
    expect(JSON.stringify(load?.result)).toContain('{{file_name}}: File name')
    expect(JSON.stringify(load?.result)).toContain('step-1.png')
    expect(read?.status).toBe('ok')
    expect(missing?.status).toBe('error')
    const images = (name: string) =>
      requests.some((r) =>
        r.messages.some(
          (m) => m.role === 'tool' && m.toolName === name && m.content.some((p) => p.type === 'image'),
        ),
      )
    expect(images('skill_load')).toBe(true)
    expect(images('skill_read')).toBe(true)
    const skills = await call<Array<{ id: string; source: string; slug: string }>>('listSkills')
    expect(skills.find((s) => s.id === procedure.id)).toMatchObject({
      source: 'taught',
      slug: 'export-resume-as-pdf',
    })

    const debug = await call<ConversationDebug>('getConversationDebug', { conversationId: chiefDm })
    const turn = debug.turns.at(-1)
    expect(turn?.trigger).toMatchObject({ authorType: 'user', snippet: 'export the résumé' })
    expect(turn?.calls).toBe(4)
    expect(debug.latestComposition[0]?.botId).toBe(chiefId)

    const edited = await call<Procedure>(
      'updateProcedure',
      { procedureId: procedure.id },
      {
        name: 'Export PDF',
        scope: 'global',
        steps: [{ id: procedure.steps[0]?.id, narration: 'Always as PDF' }],
        deleteStepIds: [procedure.steps[1]?.id],
      },
    )
    expect(edited).toMatchObject({ name: 'Export PDF', scope: 'global', botId: null })
    expect(edited.steps.map((s) => [s.position, s.narration])).toEqual([
      [1, 'Always as PDF'],
      [2, null],
    ])
    await call('deleteProcedure', { procedureId: procedure.id })
    expect(await call<Procedure[]>('listProcedures', {}, undefined, { botId: chiefId })).toEqual([])
    expect(events.some((e) => e.type === 'procedure.deleted')).toBe(true)
  })
})
