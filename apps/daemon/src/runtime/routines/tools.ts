import type { NewAgentMessage, ToolExecContext, ToolResult } from '@milibot/agent'
import { flagArg, textArg, type ToolArgs, toolError, toolText } from '@milibot/agent/tools'
import { type Message, parseSchedule, type Routine, ROUTINE_LIMITS, ScheduleError } from '@milibot/shared'

import { DaemonError } from '../../errors'
import { resolveByRef, type ToolHandlers, ToolSwitch } from '../tools-core'
import type { WorkspaceStore } from '../workspace-store'
import { describeScheduleEn, formatLocal } from './format'
import type { RoutineService } from './service'

export interface RoutineToolsDeps {
  routines: RoutineService
  store: WorkspaceStore
  appendMessage: (message: NewAgentMessage) => Message
  now: () => number
}

function describe(routine: Routine): string {
  const status = routine.lastStatus
    ? `${routine.lastStatus} at ${formatLocal(routine.lastRunAt)}`
    : 'never ran'
  return [
    `- ${routine.name} (${routine.id})${routine.enabled ? '' : ' [paused]'}: ${describeScheduleEn(routine.cron)}`,
    `  next run: ${routine.enabled ? formatLocal(routine.nextRunAt) : 'paused'}; last run: ${status}`,
    `  prompt: ${routine.prompt.length > 200 ? `${routine.prompt.slice(0, 199)}…` : routine.prompt}`,
  ].join('\n')
}

function missing(ref: string): ToolResult {
  return toolError(`No routine named "${ref}". Use routine_list to see yours.`)
}

/** The bots' routine tools: each bot sees and changes only its own routines. */
export class RoutineTools extends ToolSwitch {
  readonly name = 'routines'
  protected readonly handlers: ToolHandlers = {
    routine_create: (ctx, a) => this.create(ctx, a),
    routine_list: (ctx) => {
      const routines = this.deps.routines.list(ctx.bot.id)
      if (routines.length === 0) return toolText('You have no routines.')
      return toolText(routines.map(describe).join('\n'))
    },
    routine_update: (ctx, a) => this.update(ctx, a),
    routine_delete: (ctx, a) => {
      const ref = textArg(a, 'routine')
      const routine = this.find(ctx, ref)
      if (!routine) return missing(ref)
      this.deps.routines.delete(routine.id)
      this.systemLine(ctx, 'routine_deleted', routine.name)
      return toolText(`Routine "${routine.name}" deleted.`)
    },
  }

  constructor(private readonly deps: RoutineToolsDeps) {
    super()
  }

  private find(ctx: ToolExecContext, ref: string): Routine | null {
    const match = resolveByRef(this.deps.routines.list(ctx.bot.id), ref, {
      id: (r) => r.id,
      names: (r) => [r.name],
      ambiguous: { exact: 'first', partial: 'first' },
    })
    return 'found' in match ? match.found : null
  }

  private schedule(value: unknown): string {
    try {
      if (typeof value !== 'string' || !value.trim()) throw new ScheduleError('"schedule" is required')
      return parseSchedule(value, this.deps.now())
    } catch (err) {
      if (err instanceof ScheduleError) throw new DaemonError('validation_failed', err.message)
      throw err
    }
  }

  /** Where the bot's routine cards go; null when it has no chat to post in. */
  private conversationFor(ctx: ToolExecContext): string | null {
    try {
      return this.deps.store.conversations.forCard(ctx.bot, ctx.conversationId ?? null)
    } catch (err) {
      if (err instanceof DaemonError && err.code === 'not_found') return null
      throw err
    }
  }

  private systemLine(ctx: ToolExecContext, event: 'routine_updated' | 'routine_deleted', name: string): void {
    const conversationId = this.conversationFor(ctx)
    if (!conversationId) return
    this.deps.appendMessage({
      conversationId,
      authorType: 'system',
      kind: 'system_event',
      content:
        event === 'routine_deleted'
          ? `${ctx.bot.name} deleted the routine ${name}`
          : `${ctx.bot.name} changed the routine ${name}`,
      payload: {
        type: 'system',
        event,
        botId: ctx.bot.id,
        params: { routineName: name, actorName: ctx.bot.name },
      },
      turnId: ctx.turnId,
    })
  }

  private create(ctx: ToolExecContext, a: ToolArgs): ToolResult {
    const name = textArg(a, 'name')
    const prompt = textArg(a, 'prompt')
    if (!name) return toolError('"name" is required')
    if (!prompt) return toolError('"prompt" is required')
    if (name.length > ROUTINE_LIMITS.name) return toolError(`"name" is too long (max ${ROUTINE_LIMITS.name})`)
    if (prompt.length > ROUTINE_LIMITS.prompt)
      return toolError(`"prompt" is too long (max ${ROUTINE_LIMITS.prompt} characters)`)
    const cron = this.schedule(a.schedule)
    const routine = this.deps.routines.create(ctx.bot.id, { name, prompt, cron })
    const conversationId = this.conversationFor(ctx)
    if (conversationId) {
      this.deps.appendMessage({
        conversationId,
        authorType: 'bot',
        authorBotId: ctx.bot.id,
        kind: 'card',
        content: `Routine created: ${routine.name}`,
        payload: {
          type: 'routine_created',
          routineId: routine.id,
          botId: ctx.bot.id,
          name: routine.name,
          cron: routine.cron,
          nextRunAt: routine.nextRunAt,
        },
        turnId: ctx.turnId,
      })
    }
    return toolText(
      `Routine created: "${routine.name}" (${routine.id}), ${describeScheduleEn(routine.cron)} [cron ${routine.cron}]. Next run: ${formatLocal(routine.nextRunAt)}. The user sees it in the chat and in your settings.`,
    )
  }

  private update(ctx: ToolExecContext, a: ToolArgs): ToolResult {
    const ref = textArg(a, 'routine')
    const current = this.find(ctx, ref)
    if (!current) return missing(ref)
    const patch: { name?: string; prompt?: string; cron?: string; enabled?: boolean } = {}
    const name = textArg(a, 'name', ROUTINE_LIMITS.name)
    const prompt = textArg(a, 'prompt', ROUTINE_LIMITS.prompt)
    const enabled = flagArg(a, 'enabled')
    if (name) patch.name = name
    if (prompt) patch.prompt = prompt
    if (a.schedule !== undefined) patch.cron = this.schedule(a.schedule)
    if (enabled !== undefined) patch.enabled = enabled
    if (Object.keys(patch).length === 0)
      return toolError('Nothing to change: send name, schedule, prompt or enabled.')
    const routine = this.deps.routines.update(current.id, patch)
    this.systemLine(ctx, 'routine_updated', routine.name)
    return toolText(`Routine updated:\n${describe(routine)}`)
  }
}
