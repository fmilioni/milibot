import type { ComputerCapability } from '@milibot/shared'

/** What decides a bot's tools besides its lane: its skills' families and what the workspace's computer offers. */
export interface ToolScope {
  /** Tool families enabled for the bot (see `TOOL_FAMILIES`). */
  families: ReadonlySet<string>
  /** What the workspace's computer offers, empty without one (each tool's needs: `COMPUTER_NEEDS`). */
  capabilities: ReadonlySet<ComputerCapability>
}

/** What a bot's active skills put in its context, with the tool scope they and the computer give. */
export interface SkillContext extends ToolScope {
  /** The "# Skills" section of the system prompt; '' when no skill is active. */
  catalog: string
}
