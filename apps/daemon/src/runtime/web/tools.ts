import type { ToolExecContext, ToolResult } from '@milibot/agent'
import {
  optionalInteger,
  optionalString,
  requireString,
  stringListArg,
  type ToolArgs,
  ToolInputError,
  toolText,
  WEB_SEARCH_MAX_RESULTS,
  WEB_SEARCH_RECENCIES,
} from '@milibot/agent/tools'
import { clipLine } from '@milibot/shared'

import { type ToolHandlers, ToolSwitch } from '../tools-core'
import { SEARCH_DEFAULT_COUNT } from './limits'
import type { WebSearchRecency } from './search'
import type { WebService } from './service'

/** `web_search` (Brave or Tavily, from the daemon) and `web_fetch` (downloaded in the VM as the bot). */
export class WebTools extends ToolSwitch {
  readonly name = 'web'
  protected readonly handlers: ToolHandlers = {
    web_search: (ctx, a) => this.search(ctx, a),
    web_fetch: (ctx, a) => this.fetch(ctx, a),
  }

  constructor(private readonly deps: { web: WebService }) {
    super()
  }

  private async search(ctx: ToolExecContext, a: ToolArgs): Promise<ToolResult> {
    const recency = optionalString(a, 'recency')
    if (recency && !(WEB_SEARCH_RECENCIES as readonly string[]).includes(recency))
      throw new ToolInputError(`"recency" must be one of ${WEB_SEARCH_RECENCIES.join(', ')}`)
    const text = await this.deps.web.search(
      {
        query: requireString(a, 'query').trim(),
        count: optionalInteger(a, 'count', 1, WEB_SEARCH_MAX_RESULTS) ?? SEARCH_DEFAULT_COUNT,
        allowedDomains: stringListArg(a, 'allowed_domains'),
        blockedDomains: stringListArg(a, 'blocked_domains'),
        recency: (recency as WebSearchRecency | undefined) ?? null,
      },
      ctx.signal,
    )
    return { ...toolText(text), activity: { detail: '', result: text } }
  }

  private async fetch(ctx: ToolExecContext, a: ToolArgs): Promise<ToolResult> {
    const url = requireString(a, 'url')
    const prompt = optionalString(a, 'prompt')?.trim() || null
    const page = a.page === undefined ? null : (optionalInteger(a, 'page', 1, 10_000) ?? 1)
    const doc = await this.deps.web.read(ctx, { url, prompt, page })
    return {
      ...toolText(doc.text),
      activity: { detail: clipLine(doc.title || new URL(doc.url).hostname, 60), fullDetail: doc.url },
    }
  }
}
