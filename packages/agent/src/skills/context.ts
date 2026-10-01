/** What a bot's active skills put in its context. */
export interface SkillContext {
  /** The "# Skills" section of the system prompt; '' when no skill is active. */
  catalog: string
  /** Tool families enabled for the bot (see `TOOL_FAMILIES`). */
  families: ReadonlySet<string>
}
