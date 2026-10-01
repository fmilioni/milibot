import type { Bot } from '@milibot/shared'

import type { HostContext } from './context'
import type { LaneKind } from './lanes'

export interface CurrentProject {
  id: string
  name: string
  block: string
}

/** The knowledge base and projects as a bot's turns read them. */
export class HostKnowledge {
  constructor(private readonly ctx: HostContext) {}

  /** Knowledge blocks (catalog, suggestions, project documents) only reach bots that have the knowledge tools. */
  enabled(bot: Bot, lane: LaneKind): boolean {
    return this.ctx.env().skillContext(bot, lane).families.has('knowledge')
  }

  catalog(bot: Bot, lane: LaneKind): string {
    if (!this.enabled(bot, lane)) return ''
    const env = this.ctx.env()
    try {
      return env.knowledge.catalog(bot)
    } catch (err) {
      env.log('warn', 'knowledge catalog failed', { botId: bot.id, err: (err as Error).message })
      return ''
    }
  }

  /** Documents (and, when enabled, excerpts) relevant to the turn's input; '' on failure. */
  async forTurn(
    bot: Bot,
    texts: Array<string | undefined | null>,
    signal: AbortSignal,
    projectId: string | null,
    lane: LaneKind,
  ): Promise<string> {
    const env = this.ctx.env()
    const query = texts.filter(Boolean).join('\n').trim()
    if (!query || !this.enabled(bot, lane)) return ''
    try {
      return await env.knowledge.forTurn(bot, query, signal, projectId)
    } catch (err) {
      if (!signal.aborted)
        env.log('warn', 'knowledge suggestions failed', { botId: bot.id, err: (err as Error).message })
      return ''
    }
  }

  /** The conversation's current project and its block ('' blocks count as no project). */
  currentProject(bot: Bot, conversationId: string, lane: LaneKind): CurrentProject | null {
    const env = this.ctx.env()
    const projectId = env.getConversation(conversationId)?.projectId
    if (!projectId) return null
    try {
      const block = env.projects.block(bot, projectId, { knowledge: this.enabled(bot, lane) }).trim()
      if (!block) return null
      const found = env.projects.resolve(projectId)
      return { id: projectId, name: 'project' in found ? found.project.name : projectId, block }
    } catch (err) {
      env.log('warn', 'project block failed', { botId: bot.id, err: (err as Error).message })
      return null
    }
  }

  /** An internal conversation has no project of its own: it works for the one its messages came from. */
  projectOf(conversationId: string | null): string | null {
    if (!conversationId) return null
    const env = this.ctx.env()
    const conversation = env.getConversation(conversationId)
    if (conversation?.projectId || conversation?.type !== 'internal') return conversation?.projectId ?? null
    for (const origin of this.ctx.messaging.origins(conversationId)) {
      const projectId = env.getConversation(origin)?.projectId
      if (projectId) return projectId
    }
    return null
  }
}
