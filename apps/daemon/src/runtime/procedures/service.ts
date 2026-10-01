import {
  type AgentHost,
  fallbackProcedure,
  markClick,
  type NewAgentMessage,
  parseProcedure,
  pickScreenshotSteps,
  pngSize,
  type ProcedureDraft,
} from '@milibot/agent'
import type { ContentPart } from '@milibot/agent/llm'
import { buildProcedurePrompt } from '@milibot/agent/prompts'
import {
  type Bot,
  type FinishTeachBody,
  type Language,
  type LogFn,
  type Message,
  type Procedure,
  type procedureEndpoints,
  type RecordedStep,
  type UpdateProcedureBody,
  type WorkspaceEvent,
} from '@milibot/shared'
import type { z } from 'zod'

import type { Db } from '../../db/sqlite'
import { DaemonError, errorMessage, notFound } from '../../errors'
import type { EndpointHandlers } from '../../handlers'
import type { FileBlobStore } from '../blobs'
import type { VmController } from '../vm'
import type { WorkspaceStore } from '../workspace-store'
import { type NewStep, type ProcedureRow, ProcedureStore } from './store'

const GENERATION_TIMEOUT_MS = 180_000
const MAX_OUTPUT_TOKENS = 4000
/** Recordings abandoned (app closed mid-recording) are dropped after this. */
const STALE_RECORDING_MS = 12 * 60 * 60 * 1000

type ProcedureEndpoint = keyof typeof procedureEndpoints

function stepFields(step: RecordedStep): { value: string | null; x: number | null; y: number | null } {
  return {
    value: step.kind === 'type' ? (step.text ?? null) : step.kind === 'key' ? (step.keys ?? null) : null,
    x: step.x ?? null,
    y: step.y ?? null,
  }
}

export interface ProcedureServiceDeps {
  db: Db
  store: WorkspaceStore
  vm: VmController
  blobs: FileBlobStore
  host: AgentHost
  emit: (event: WorkspaceEvent) => void
  appendMessage: (message: NewAgentMessage) => Message
  now: () => number
  log?: LogFn
}

/** Procedures taught with "Teach": recording, generation by a model and CRUD (bots load them as skills). */
export class ProcedureService {
  private readonly generating = new Map<string, Promise<void>>()
  private readonly procedures: ProcedureStore

  constructor(private readonly deps: ProcedureServiceDeps) {
    this.procedures = new ProcedureStore(deps.db, deps.now)
  }

  /** Step screenshots, shown for as long as their procedure exists. */
  referencedBlobs(): string[] {
    return this.procedures.referencedBlobs()
  }

  start(): void {
    for (const id of this.procedures.staleRecordings(this.deps.now() - STALE_RECORDING_MS)) {
      this.removeTeachLines(id)
      this.procedures.remove(id)
    }
    this.procedures.finishInterruptedGenerations()
  }

  /** Resolves when no procedure is being written (tests). */
  async idle(): Promise<void> {
    await Promise.all([...this.generating.values()])
  }

  get(id: string): Procedure {
    return this.procedures.toProcedure(this.procedures.row(id))
  }

  /** Ready and generating procedures; with `botId`, only the ones that bot can use. */
  list(botId?: string): Procedure[] {
    return this.procedures.list(botId).map((r) => this.procedures.toProcedure(r))
  }

  private emitProcedure(id: string): Procedure {
    const procedure = this.get(id)
    this.deps.emit({ type: 'procedure.updated', payload: { procedure } })
    return procedure
  }

  /** Where the teach lines go: the chat it started from (never an internal one), else the bot's DM. */
  private teachConversation(bot: Bot, conversationId: string | null): string | null {
    try {
      return this.deps.store.conversations.forCard(bot, conversationId)
    } catch (err) {
      if (err instanceof DaemonError && err.code === 'not_found' && !conversationId) return null
      throw err
    }
  }

  startTeach(botId: string, body: { conversationId?: string | null | undefined; name: string }): Procedure {
    const bot = this.deps.store.bots.get(botId)
    const conversationId = this.teachConversation(bot, body.conversationId ?? null)
    const id = this.procedures.insertRecording({ botId: bot.id, conversationId, name: body.name })
    if (conversationId) {
      const name = body.name.trim()
      this.deps.appendMessage({
        conversationId,
        authorType: 'system',
        kind: 'system_event',
        content: name ? `You started teaching "${name}" to ${bot.name}` : `You started teaching ${bot.name}`,
        payload: {
          type: 'system',
          event: 'teach_started',
          botId: bot.id,
          params: { botName: bot.name, procedureName: name, procedureId: id },
        },
      })
    }
    return this.get(id)
  }

  private recording(procedureId: string): ProcedureRow {
    const row = this.procedures.row(procedureId)
    if (row.status !== 'recording') throw new DaemonError('conflict', 'This procedure is not being recorded')
    return row
  }

  async screenshot(procedureId: string): Promise<{ sha256: string; width: number; height: number }> {
    const row = this.recording(procedureId)
    const bot = this.deps.store.bots.get(row.taught_by_bot_id ?? '')
    const png = await this.deps.vm.runningGuest().screenshot(bot.displayNum)
    const sha256 = await this.deps.blobs.put(png, 'image/png')
    this.procedures.touch(procedureId)
    const size = pngSize(png)
    return { sha256, width: size?.width ?? 1280, height: size?.height ?? 800 }
  }

  finishTeach(procedureId: string, body: z.output<typeof FinishTeachBody>): Procedure {
    const row = this.recording(procedureId)
    this.procedures.transaction(() => {
      this.procedures.startGeneration(procedureId, {
        name: body.name,
        botId: body.scope === 'global' ? null : row.taught_by_bot_id,
        recording: JSON.stringify(body.steps),
      })
      this.replaceSteps(
        procedureId,
        fallbackProcedure(body.name, body.steps, body.language ?? 'pt-BR'),
        body.steps,
      )
    })
    const procedure = this.emitProcedure(procedureId)
    const job = this.generate(procedureId, body.steps, body.language ?? 'pt-BR').finally(() =>
      this.generating.delete(procedureId),
    )
    this.generating.set(procedureId, job)
    return procedure
  }

  private replaceSteps(procedureId: string, procedure: ProcedureDraft, recorded: RecordedStep[]): void {
    this.procedures.replaceSteps(
      procedureId,
      procedure.steps.map((step): NewStep => {
        const source = step.recorded ? recorded[step.recorded - 1] : undefined
        const fields = source ? stepFields(source) : { value: null, x: null, y: null }
        return {
          kind: step.kind,
          action: step.instruction,
          target: step.target,
          value: step.value ?? fields.value,
          x: fields.x,
          y: fields.y,
          narration: source?.narration?.trim() || null,
          screenshotSha: source?.screenshotSha ?? null,
        }
      }),
    )
  }

  /** Screenshot with the clicked point ringed (stored as a blob), as an image part for a model. */
  async markedImage(sha: string, x: number | null, y: number | null): Promise<ContentPart | null> {
    try {
      const png = await this.deps.blobs.read(sha)
      const marked = x !== null && y !== null ? markClick(png, x, y) : null
      const bytes = marked ?? png
      const size = pngSize(bytes)
      const markedSha = marked ? await this.deps.blobs.put(marked, 'image/png') : sha
      return {
        type: 'image',
        sha256: markedSha,
        mediaType: 'image/png',
        width: size?.width ?? 1280,
        height: size?.height ?? 800,
      }
    } catch (err) {
      this.deps.log?.('warn', 'procedure screenshot unavailable', { sha, err: errorMessage(err) })
      return null
    }
  }

  private async generate(procedureId: string, recorded: RecordedStep[], language: Language): Promise<void> {
    const row = this.procedures.row(procedureId)
    const bot = row.taught_by_bot_id ? this.deps.store.bots.find(row.taught_by_bot_id) : null
    let procedure: ProcedureDraft | null = null
    let error: string | null = null
    let llmCallId: string | null = null
    if (bot) {
      try {
        const shots = pickScreenshotSteps(recorded)
        const images: ContentPart[] = []
        const sent: number[] = []
        for (const index of shots) {
          const step = recorded[index] as RecordedStep
          const image = await this.markedImage(step.screenshotSha as string, step.x ?? null, step.y ?? null)
          if (!image) continue
          images.push(image)
          sent.push(index)
        }
        const { system, prompt } = buildProcedurePrompt({
          name: row.name,
          botName: bot.name,
          steps: recorded,
          language,
          screenshots: sent,
        })
        const result = await this.deps.host.writeText({
          botId: bot.id,
          conversationId: row.conversation_id,
          purpose: 'procedure',
          system,
          prompt,
          images,
          maxOutputTokens: MAX_OUTPUT_TOKENS,
          signal: AbortSignal.timeout(GENERATION_TIMEOUT_MS),
        })
        llmCallId = result.llmCallId
        procedure = parseProcedure(result.text, recorded.length)
        if (!procedure) error = 'The model answer could not be read; the recording was kept as is.'
      } catch (err) {
        error = errorMessage(err)
        this.deps.log?.('warn', 'procedure generation failed', { procedureId, err: error })
      }
    } else {
      error = 'The bot that was taught no longer exists.'
    }
    const exists = this.procedures.transaction(() => {
      if (!this.procedures.find(procedureId)) return false
      if (procedure) {
        this.replaceSteps(procedureId, procedure, recorded)
        this.procedures.saveDraft(procedureId, procedure)
      }
      this.procedures.markReady(procedureId, error, llmCallId)
      return true
    })
    if (!exists) return
    const saved = this.emitProcedure(procedureId)
    if (row.conversation_id) {
      try {
        this.deps.appendMessage({
          conversationId: row.conversation_id,
          authorType: 'system',
          kind: 'card',
          content: `Procedure saved: ${saved.name}`,
          payload: {
            type: 'procedure_saved',
            procedureId,
            botId: saved.taughtByBotId,
            name: saved.name,
            scope: saved.scope,
            steps: saved.steps.length,
          },
        })
      } catch (err) {
        this.deps.log?.('warn', 'procedure card not posted', { procedureId, err: errorMessage(err) })
      }
    }
  }

  update(procedureId: string, body: z.output<typeof UpdateProcedureBody>): Procedure {
    const row = this.procedures.row(procedureId)
    if (row.status === 'recording')
      throw new DaemonError('conflict', 'This procedure is still being recorded')
    this.procedures.transaction(() => {
      this.procedures.update(procedureId, {
        name: body.name ?? row.name,
        goal: body.goal ?? row.goal,
        botId: body.scope === undefined ? row.bot_id : body.scope === 'global' ? null : row.taught_by_bot_id,
        preconditions: body.preconditions ? JSON.stringify(body.preconditions) : row.preconditions,
      })
      for (const step of body.steps ?? []) {
        const current = this.procedures.step(procedureId, step.id)
        if (!current) throw notFound('procedure step', step.id)
        this.procedures.updateStep(
          step.id,
          step.instruction?.trim() || current.action,
          step.narration === undefined ? current.narration : step.narration?.trim() || null,
        )
      }
      if (body.deleteStepIds?.length) this.procedures.deleteSteps(procedureId, body.deleteStepIds)
    })
    return this.emitProcedure(procedureId)
  }

  delete(procedureId: string): void {
    const row = this.procedures.row(procedureId)
    if (row.status === 'recording') this.removeTeachLines(procedureId)
    this.procedures.remove(procedureId)
    this.deps.emit({ type: 'procedure.deleted', payload: { procedureId } })
  }

  /** The `teach_started` lines of a recording that was discarded: nothing was taught. */
  private removeTeachLines(procedureId: string): void {
    const { messages, conversations } = this.deps.store
    const lines = messages.systemEvents('teach_started', 'procedureId', procedureId)
    if (lines.length === 0) return
    this.procedures.transaction(() => {
      for (const line of lines) messages.delete(line.id)
    })
    for (const line of lines)
      this.deps.emit({
        type: 'message.deleted',
        payload: { conversationId: line.conversationId, messageId: line.id },
      })
    for (const conversationId of new Set(lines.map((l) => l.conversationId))) {
      try {
        this.deps.emit({
          type: 'conversation.updated',
          payload: { conversation: conversations.get(conversationId) },
        })
      } catch {
        // Conversation gone with its messages.
      }
    }
  }

  handlers(): EndpointHandlers<ProcedureEndpoint> {
    return {
      listProcedures: ({ query }) => this.list(query.botId),
      getProcedure: ({ params }) => this.get(params.procedureId),
      updateProcedure: ({ params, body }) => this.update(params.procedureId, body),
      deleteProcedure: ({ params }) => {
        this.delete(params.procedureId)
        return { ok: true as const }
      },
      startTeach: ({ params, body }) => this.startTeach(params.botId, body),
      teachScreenshot: ({ params }) => this.screenshot(params.procedureId),
      finishTeach: ({ params, body }) => this.finishTeach(params.procedureId, body),
    }
  }
}
