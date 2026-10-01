import type { ToolExecContext, ToolResult } from '@milibot/agent'
import type { ToolCall } from '@milibot/agent/llm'
import type { DesignToolName } from '@milibot/agent/tools'

import { type ToolHandler, ToolSwitch } from '../../tools-core'
import type { DesignToolsDeps } from './deps'
import { designHandlers } from './designs'
import { frameHandlers } from './frames'
import { outputHandlers } from './output'

/** The bots' `design_*` tools; outcomes of background drawings are appended to the bot's next result. */
export class DesignTools extends ToolSwitch {
  readonly name = 'designs'
  protected readonly handlers: Record<DesignToolName, ToolHandler>

  constructor(private readonly deps: DesignToolsDeps) {
    super()
    this.handlers = { ...designHandlers(deps), ...frameHandlers(deps), ...outputHandlers(deps) }
  }

  override async execute(ctx: ToolExecContext, call: ToolCall): Promise<ToolResult> {
    const result = await super.execute(ctx, call)
    const notices = this.deps.designs.artwork?.takeNotices(ctx.bot.id) ?? []
    if (notices.length === 0) return result
    const first = result.content[0]
    const note = notices.join('\n')
    return {
      ...result,
      content:
        first?.type === 'text'
          ? [{ ...first, text: `${first.text}\n\n${note}` }, ...result.content.slice(1)]
          : [...result.content, { type: 'text', text: note }],
    }
  }
}
