import type { ToolExecContext, ToolResult } from '@milibot/agent'
import { exactInteger, textArg, type ToolArgs, toolError, toolText } from '@milibot/agent/tools'
import { TaskStatus } from '@milibot/shared'

import { ToolSwitch } from '../tools-core'
import { STATUS_WORDS, type TaskCardService } from './service'

export interface TaskCardToolsDeps {
  cards: Pick<TaskCardService, 'report'>
}

/** `report_task`: a task card the bot posts and keeps up to date. */
export class TaskCardTools extends ToolSwitch {
  readonly name = 'task cards'
  protected readonly handlers = {
    report_task: (ctx: ToolExecContext, a: ToolArgs) => this.reportTask(ctx, a),
  }

  constructor(private readonly deps: TaskCardToolsDeps) {
    super()
  }

  private reportTask(ctx: ToolExecContext, a: ToolArgs): ToolResult {
    const title = textArg(a, 'title', 120)
    const status = TaskStatus.safeParse(a.status)
    if (!title) return toolError('"title" is required.')
    if (!status.success) return toolError('"status" must be one of open, review, done, failed.')
    const givenUrl = textArg(a, 'url')
    const url = /^https?:\/\//.test(givenUrl) ? givenUrl : null
    if (givenUrl && !url) return toolError('"url" must start with https://.')
    const fromUrl = url ? /github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/.exec(url) : null
    const prNumber = exactInteger(a, 'pr_number') ?? (fromUrl ? Number(fromUrl[2]) : null)
    const repo = textArg(a, 'repo')
    const reported = this.deps.cards.report(ctx.bot, ctx.conversationId, ctx.turnId, {
      title,
      status: status.data,
      url,
      repo: repo.includes('/') ? repo : (fromUrl?.[1] ?? null),
      prNumber,
      branch: textArg(a, 'branch') || null,
      botId: ctx.bot.id,
    })
    if (!reported) return toolError('No conversation to post the card in.')
    return toolText(
      reported.updated ? `Updated the task card (${STATUS_WORDS[status.data]}).` : 'Posted the task card.',
    )
  }
}
