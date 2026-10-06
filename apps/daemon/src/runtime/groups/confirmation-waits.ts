import type { AgentHost, ToolExecContext } from '@milibot/agent'
import type { Bot } from '@milibot/shared'

import { stopped } from '../tools-core'

export interface ConfirmationWaitsDeps {
  host: Pick<AgentHost, 'enqueueTurn'>
  findBot: (id: string) => Bot | null
  timeoutSeconds: () => number
}

/**
 * A tool call waiting for the outcome of a confirmation card, like `ask_user` (detached): what is settled
 * after it stopped waiting, an approval after a restart included, reaches the bot as a `user_answer` turn.
 */
export class ConfirmationWaits {
  private readonly waiters = new Map<string, (text: string) => void>()

  constructor(private readonly deps: ConfirmationWaitsDeps) {}

  clear(): void {
    this.waiters.clear()
  }

  wait(ctx: ToolExecContext, key: string): Promise<string> {
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
  settle(key: string, botId: string, conversationId: string, text: string): void {
    const waiter = this.waiters.get(key)
    if (waiter) {
      waiter(text)
      return
    }
    if (!this.deps.findBot(botId)) return
    this.deps.host.enqueueTurn({ botId, conversationId, trigger: 'user_answer', note: `[Milibot] ${text}` })
  }
}
