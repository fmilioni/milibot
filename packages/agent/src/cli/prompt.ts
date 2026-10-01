import type { Bot, CliEngine, Language } from '@milibot/shared'

import type { LaneKind } from '../host/lanes'
import type { ToolDefinition } from '../llm/provider'
import { composeSystemPrompt, type PromptContext } from '../prompts/rules'
import type { SkillContext } from '../skills/context'
import { toolsForLane } from '../tools/policy'
import { CLI_ENGINE_DRIVERS } from './registry'

export interface CliPrompt {
  /** Milibot rules + persona + team (the engine's system prompt addition, without the memory bootstrap). */
  instructions: string
  /** Milibot's tools the engine reaches through its MCP server. */
  mcpTools: ToolDefinition[]
}

/** What Milibot sends a CLI engine bot besides its memory and lane rules. */
export function cliPrompt(
  engine: CliEngine,
  bot: Bot,
  team: PromptContext['team'],
  language: Language | null = null,
  lane: LaneKind = 'main',
  skills: SkillContext | null = null,
  options: { readOnly?: boolean } = {},
): CliPrompt {
  const driver = CLI_ENGINE_DRIVERS[engine]
  return {
    instructions: composeSystemPrompt({
      bot,
      team,
      cli: driver.wording,
      language,
      helper: lane === 'subagent',
      skills,
    }),
    mcpTools: toolsForLane(lane, {
      native: driver.nativeInMcp,
      readOnly: options.readOnly === true,
      ...(skills ? { enabledFamilies: skills.families } : {}),
    }),
  }
}
