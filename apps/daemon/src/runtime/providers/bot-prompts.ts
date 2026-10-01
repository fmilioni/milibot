import type { AgentHost, ResolvedModel } from '@milibot/agent'
import { generateBotPrompt } from '@milibot/agent/prompts'
import type { LogFn, promptVersionEndpoints } from '@milibot/shared'

import { DaemonError, errorMessage } from '../../errors'
import type { EndpointHandlers } from '../../handlers'
import type { WorkspaceStore } from '../workspace-store'

export interface BotPromptDeps {
  store: WorkspaceStore
  host: Pick<AgentHost, 'writeText'>
  /** The model for new bots (`bots.default_model`), when set and available. */
  defaultModel?: () => Promise<ResolvedModel | null>
  log?: LogFn
}

/**
 * Drafts a new bot's persona from the user's description with the model for new bots, else the first bot's
 * summary model (haiku one-shot for Claude Code), logged in `llm_calls` with `purpose: bot_prompt` on behalf of
 * the first bot.
 */
export class BotPromptRoutes {
  constructor(private readonly deps: BotPromptDeps) {}

  handlers(): EndpointHandlers<Extract<keyof typeof promptVersionEndpoints, 'generateBotPrompt'>> {
    const { deps } = this
    return {
      generateBotPrompt: async ({ body }) => {
        const bot = deps.store.bots.first()
        if (!bot) throw new DaemonError('conflict', 'The workspace has no bots')
        const model = (await deps.defaultModel?.()) ?? null
        try {
          return await generateBotPrompt(body, async (request) => {
            const { text } = await deps.host.writeText({
              botId: bot.id,
              conversationId: null,
              purpose: 'bot_prompt',
              ...(model ? { model } : {}),
              ...request,
            })
            return text
          })
        } catch (err) {
          deps.log?.('warn', 'bot prompt generation failed', { err: errorMessage(err) })
          throw new DaemonError('conflict', `Could not generate the prompt: ${errorMessage(err)}`, {
            reason: 'generation_failed',
          })
        }
      },
    }
  }
}
