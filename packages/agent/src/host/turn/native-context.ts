import type { ContextComposition } from '@milibot/shared'
import { type Bot, estimateTokens } from '@milibot/shared'

import type { NativeResolvedModel, TurnRequest, WorkSessionView } from '../../environment'
import type { ChatMessage } from '../../llm/messages'
import type { ToolDefinition } from '../../llm/provider'
import type { BotMcpToolSet } from '../../mcp/tools'
import {
  addTurnKnowledge,
  buildContext,
  type BuiltContext,
  contextComposition as sectionComposition,
} from '../../memory/context-builder'
import { composition } from '../../memory/tokens'
import { sessionRules, subagentRules } from '../../prompts/lanes'
import { composeSystemPrompt, introInstruction, personaSection } from '../../prompts/rules'
import type { SkillContext } from '../../skills/context'
import { toolsForLane } from '../../tools/policy'
import type { HostContext } from '../context'
import type { LaneState, TurnState } from '../state'
import { subagentInput, type SubagentRun } from '../subagents'
import type { SessionTranscript } from '../work-sessions/session-context'

/** What the step loop of a native turn starts from. */
export interface NativeContext {
  helper: SubagentRun | null
  session: WorkSessionView | null
  tools: ToolDefinition[]
  system: ChatMessage
  /** Grows as the loop appends responses and tool results. */
  conversation: ChatMessage[]
  /** Session lanes: the stored transcript the conversation replays (compacted inside the loop). */
  transcript: SessionTranscript | null
  /** Estimated composition of the current context, for `llm_calls`. */
  compose(): ContextComposition
}

export function teamOf(bots: Bot[]): Array<Pick<Bot, 'name' | 'label' | 'slug'>> {
  return bots.map((b) => ({ name: b.name, label: b.label, slug: b.slug }))
}

/** Rules + persona + team + skills, then the lane's own rules (a helper's task, a session's). */
function systemPromptOf(
  ctx: HostContext,
  bot: Bot,
  skills: SkillContext,
  helper: SubagentRun | null,
  session: WorkSessionView | null,
): string {
  const env = ctx.env()
  const base = composeSystemPrompt({
    bot,
    team: teamOf(env.listBots()),
    language: env.userLanguage(),
    helper: !!helper,
    skills,
  })
  if (helper) return `${base}\n\n${subagentRules(session, helper.readOnly)}`
  if (session) return `${base}\n\n${sessionRules(session, null, skills.families.has('secrets'))}`
  return base
}

/** The bot's external MCP tools; none for the intro, read-only helpers or when the servers fail. */
async function externalTools(
  ctx: HostContext,
  bot: Bot,
  request: TurnRequest,
  helper: SubagentRun | null,
): Promise<BotMcpToolSet | null> {
  if (request.trigger === 'intro' || helper?.readOnly) return null
  const env = ctx.env()
  return env.mcpTools(bot).catch((err: unknown) => {
    env.log('warn', 'external MCP tools unavailable', { botId: bot.id, err: (err as Error).message })
    return null
  })
}

/** Puts the turn's notes right after the documents in its latest input (or as a new input). */
function addTurnNotes(built: BuiltContext, notes: string[]): void {
  if (notes.length === 0) return
  const conversation = built.conversation
  let at = conversation.length
  while (at > 0 && conversation[at - 1]?.role !== 'assistant') at--
  const target = conversation[at]
  const parts = notes.map((text) => ({ type: 'text' as const, text }))
  const after = (built.sections.retrieved ? 1 : 0) + (built.sections.knowledgeTurn ? 1 : 0)
  if (target?.role === 'user') target.content.splice(after, 0, ...parts)
  else conversation.push({ role: 'user', content: parts })
}

/**
 * Context of a native turn by lane: a helper starts from its task alone and keeps nothing (its report is what
 * stays); a session lane replays its stored transcript; a chat lane reads the conversation through memory
 * (`buildContext`) with the turn's documents and notes in its latest input.
 */
export async function nativeContext(
  ctx: HostContext,
  bot: Bot,
  request: TurnRequest,
  turn: TurnState,
  lane: LaneState,
  session: WorkSessionView | null,
  resolved: NativeResolvedModel,
): Promise<NativeContext> {
  const env = ctx.env()
  const helper = ctx.helpers.get(lane.info.key) ?? null
  const kind = lane.info.kind
  const skills = env.skillContext(bot, kind)
  const systemPrompt = systemPromptOf(ctx, bot, skills, helper, session)
  const external = await externalTools(ctx, bot, request, helper)
  const tools: ToolDefinition[] =
    request.trigger === 'intro'
      ? []
      : [
          ...toolsForLane(kind, { readOnly: helper?.readOnly === true, enabledFamilies: skills.families }),
          ...(external?.tools ?? []),
        ]
  turn.offeredTools = new Set(tools.map((tool) => tool.name))
  const mcpServers =
    external && Object.keys(external.tokensByServer).length ? { mcpServers: external.tokensByServer } : {}
  const persona = estimateTokens(personaSection(bot))
  const withExtras = (base: ContextComposition): ContextComposition => ({ ...base, ...mcpServers, persona })
  const plainSystem: ChatMessage = {
    role: 'system',
    content: [{ type: 'text', text: systemPrompt, cacheBreakpoint: true }],
  }

  if (helper) {
    const conversation: ChatMessage[] = [
      { role: 'user', content: [{ type: 'text', text: subagentInput(helper, session) }] },
    ]
    return {
      helper,
      session,
      tools,
      system: plainSystem,
      conversation,
      transcript: null,
      compose: () => withExtras(composition(systemPrompt, tools, conversation)),
    }
  }
  if (session) {
    const setup = await ctx.sessions.nativeContext(bot, session, lane, request, turn, systemPrompt)
    return {
      helper,
      session,
      tools,
      system: setup.system,
      conversation: setup.conversation,
      transcript: setup.transcript,
      compose: () => withExtras(composition(setup.systemText, tools, setup.conversation)),
    }
  }
  const config = ctx.memory.forTurn(bot.id, resolved.contextWindow)
  if (request.trigger === 'intro') {
    ctx.reads.markRead(bot.id, request.conversationId)
    const conversation: ChatMessage[] = [
      { role: 'user', content: [{ type: 'text', text: introInstruction(bot) }] },
    ]
    return {
      helper,
      session,
      tools,
      system: plainSystem,
      conversation,
      transcript: null,
      compose: () => withExtras(composition(systemPrompt, tools, conversation)),
    }
  }
  const unread = ctx.inputs.takeUnread(bot, request)
  const project = ctx.knowledge.currentProject(bot, request.conversationId, kind)
  const built = buildContext({
    bot,
    conversationId: request.conversationId,
    systemPrompt,
    tools,
    memory: env.memory,
    botsById: ctx.botsById(),
    config,
    knowledgeCatalog: ctx.knowledge.catalog(bot, kind),
    projectId: project?.id ?? null,
    projectBlock: project?.block ?? '',
  })
  const knowledge = await ctx.inputs.knowledge(bot, request, lane, turn.abort.signal, {
    session: null,
    projectId: project?.id ?? null,
    query: built.input,
  })
  addTurnKnowledge(built, knowledge)
  addTurnNotes(built, ctx.inputs.notes(bot, request, lane, null, unread.missedRoutine))
  return {
    helper,
    session,
    tools,
    system: built.system,
    conversation: built.conversation,
    transcript: null,
    compose: () => withExtras(sectionComposition(built, built.conversation)),
  }
}
