import type { AgentHost, ToolExecContext } from '@milibot/agent'
import {
  type Bot,
  type ConfirmationPayload,
  type LogFn,
  type Message,
  UpdateWorkspacePreferencesBody,
  type WorkspacePreferences,
} from '@milibot/shared'
import type { z } from 'zod'

import { DaemonError, errorMessage } from '../../errors'
import type { ConfirmationAction, ConfirmationHandler, ConfirmationParams } from '../groups'
import { stopped } from '../tools-core'
import type { BotSettingName } from './bot-fields'
import type { SettingsService } from './service'

const ACTION: ConfirmationAction = 'workspace_settings'

/** One field of a proposed change: the value when proposed and the one asked for. */
export interface SettingChange {
  field: BotSettingName
  from: unknown
  to: unknown
}

export interface SettingChangesDeps {
  settings: Pick<SettingsService, 'update'>
  confirmations: {
    request(input: {
      bot: Bot
      conversationId: string | null
      action: ConfirmationAction
      params: ConfirmationParams
      reason: string
      data: Record<string, unknown>
    }): Message
    onConfirmed(action: ConfirmationAction, handler: ConfirmationHandler): void
    onRejected(action: ConfirmationAction, handler: ConfirmationHandler): void
  }
  host: Pick<AgentHost, 'enqueueTurn'>
  findBot: (id: string) => Bot | null
  /** How the bot reads a value back (model names instead of ids). */
  describe: (bot: Bot | null, change: SettingChange) => string
  timeoutSeconds: () => number
  log: LogFn
}

const fieldList = (changes: SettingChange[]) => changes.map((c) => c.field).join(', ')

/**
 * Changes of workspace preferences that wait for the user's confirmation card: applied through
 * `SettingsService.update` (the settings screen's path) once approved. The tool waits like `ask_user`
 * (detached); a decision taken after it stopped waiting, an approval after a restart included, reaches the
 * bot as a `user_answer` turn.
 */
export class SettingChanges {
  private readonly waiters = new Map<string, (text: string) => void>()

  constructor(private readonly deps: SettingChangesDeps) {
    deps.confirmations.onConfirmed(ACTION, (input) => this.approved(input))
    deps.confirmations.onRejected(ACTION, (input) => this.rejected(input))
  }

  stop(): void {
    this.waiters.clear()
  }

  /** Posts the confirmation card and waits for the user's decision. */
  propose(ctx: ToolExecContext, changes: SettingChange[], reason: string): Promise<string> {
    const message = this.deps.confirmations.request({
      bot: ctx.bot,
      conversationId: ctx.conversationId,
      action: ACTION,
      params: {
        botId: ctx.bot.id,
        botName: ctx.bot.name,
        fields: fieldList(changes),
        changes: JSON.stringify(
          changes.map((c) => ({ field: c.field, from: c.from ?? null, to: c.to ?? null })),
        ),
      },
      reason,
      data: { changes },
    })
    const { confirmationId } = message.payload as ConfirmationPayload
    return this.wait(ctx, confirmationId)
  }

  private wait(ctx: ToolExecContext, key: string): Promise<string> {
    const seconds = this.deps.timeoutSeconds()
    const wait = new Promise<string>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer)
        ctx.signal.removeEventListener('abort', onAbort)
        this.waiters.delete(key)
      }
      const onAbort = () => {
        cleanup()
        reject(stopped())
      }
      const timer = setTimeout(
        () => {
          cleanup()
          resolve(
            `The user has not decided yet (waited ${Math.round(seconds / 60)} min); the card stays in the ` +
              'chat. You get a note with the outcome when they do: do not ask again.',
          )
        },
        Math.max(10, seconds * 1000),
      )
      this.waiters.set(key, (text) => {
        cleanup()
        resolve(text)
      })
      ctx.signal.addEventListener('abort', onAbort, { once: true })
      if (ctx.signal.aborted) onAbort()
    })
    return ctx.detach ? ctx.detach(wait) : wait
  }

  /** Hands the outcome to the waiting tool call, else to the bot as a new turn. */
  private settle(key: string, botId: string, conversationId: string, text: string): void {
    const waiter = this.waiters.get(key)
    if (waiter) {
      waiter(text)
      return
    }
    if (!this.deps.findBot(botId)) return
    this.deps.host.enqueueTurn({ botId, conversationId, trigger: 'user_answer', note: `[Milibot] ${text}` })
  }

  private changesOf(data: Record<string, unknown>): SettingChange[] {
    return Array.isArray(data.changes) ? (data.changes as SettingChange[]) : []
  }

  private rejected(input: Parameters<ConfirmationHandler>[0]): void {
    const changes = this.changesOf(input.data)
    this.settle(
      input.confirmationId,
      input.requesterId,
      input.conversationId,
      `The user rejected the change of ${fieldList(changes)}. Nothing changed.`,
    )
  }

  private approved(input: Parameters<ConfirmationHandler>[0]): void {
    const changes = this.changesOf(input.data)
    const parsed = UpdateWorkspacePreferencesBody.safeParse(
      Object.fromEntries(changes.map((c) => [c.field, c.to])),
    )
    if (!parsed.success || changes.length === 0) {
      this.settle(
        input.confirmationId,
        input.requesterId,
        input.conversationId,
        'The approved change is no longer valid, so it was not applied. Nothing changed.',
      )
      throw new DaemonError('validation_failed', 'The proposed settings are no longer valid')
    }
    let text: string
    try {
      const after = this.deps.settings.update(parsed.data as z.output<typeof UpdateWorkspacePreferencesBody>)
      const bot = this.deps.findBot(input.requesterId)
      const applied = changes.map((c) =>
        this.deps.describe(bot, { ...c, to: after[c.field as keyof WorkspacePreferences] }),
      )
      text = `The user approved it. Changed: ${applied.join('; ')}.`
    } catch (err) {
      this.deps.log('warn', 'workspace settings change failed', { err: errorMessage(err) })
      text = `The user approved it, but it could not be applied: ${errorMessage(err)}`
    }
    this.settle(input.confirmationId, input.requesterId, input.conversationId, text)
  }
}
