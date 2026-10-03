import type { LaneKind } from '../host/lanes'
import type { ToolDefinition } from '../llm/provider'
import { isToolName, TOOL_DEFINITIONS, type ToolName } from './catalog'
import { BOARD_READ_TOOLS, boardTools } from './families/boards'
import { browserTools } from './families/browser'
import { designTools } from './families/design'
import { imageTools } from './families/images'
import { knowledgeTools } from './families/knowledge'
import { mcpServerTools } from './families/mcp-servers'
import { planTools } from './families/plans'
import { projectTools } from './families/projects'
import { routineTools } from './families/routines'

/** A read-only helper's whole set (external MCP tools excluded): it investigates and reports. */
export const READ_ONLY_HELPER_TOOLS: readonly ToolName[] = [
  'bash',
  'file_read',
  'grep',
  'glob',
  'web_search',
  'web_fetch',
  'memory_search',
  'history_search',
  'knowledge_search',
  'knowledge_read',
  'knowledge_list',
  'skill_load',
  'skill_read',
  'repo_list',
  'plan_get',
  'plan_search',
  'design_list',
  'design_read',
  'design_screenshot',
  ...BOARD_READ_TOOLS,
  'browser_snapshot',
]

/**
 * Tools that come with a built-in skill (its `milibot.tools`): a family is offered only while no built-in
 * declaring it is off for the bot. Tools outside every family are always offered.
 */
export const TOOL_FAMILIES = {
  browser: [...browserTools.names],
  computer: ['computer'],
  repos: ['repo_checkout', 'repo_list', 'repo_release', 'report_task'],
  projects: [...projectTools.names],
  // plan_step stays out: other bots mark the steps of a plan they were asked to help with.
  plans: [...planTools.names.filter((name) => name !== 'plan_step'), 'session_start', 'list_models'],
  knowledge: [...knowledgeTools.names],
  routines: [...routineTools.names],
  secrets: ['request_secret', 'list_secrets'],
  team: ['create_bot', 'update_bot', 'delete_bot', 'create_group'],
  skills: ['skill_save', 'skill_delete'],
  design: [...designTools.names],
  boards: [...boardTools.names],
  web_search: ['web_search'],
  image_generation: [...imageTools.names],
  mcp_servers: [...mcpServerTools.names],
} satisfies Record<string, ToolName[]>

export type ToolFamily = keyof typeof TOOL_FAMILIES
export const TOOL_FAMILY_NAMES = Object.keys(TOOL_FAMILIES) as ToolFamily[]
/** Families no skill declares: the daemon drops them from `SkillContext.families` while their setting is off. */
export const SETTING_FAMILIES = ['web_search', 'image_generation'] as const satisfies readonly ToolFamily[]
export type SettingFamily = (typeof SETTING_FAMILIES)[number]

export function isToolFamily(name: string): name is ToolFamily {
  return Object.hasOwn(TOOL_FAMILIES, name)
}

/** The family a tool belongs to, or null for tools every bot always has. */
export function toolFamily(name: string): ToolFamily | null {
  for (const family of TOOL_FAMILY_NAMES)
    if ((TOOL_FAMILIES[family] as readonly string[]).includes(name)) return family
  return null
}

/**
 * Tools that only make sense in one kind of lane: opening sessions from the chat and closing them from
 * inside one. A helper does one task: no user, no plan, no helpers of its own, and no changes to the team,
 * its persona, routines, projects or MCP servers.
 * `without`: removed from the full set; `keep`: what the lane's own rules rely on, offered even when its
 * skill is off.
 */
const LANE_TOOLS: Record<LaneKind, { without: ToolName[]; keep: ToolName[] }> = {
  main: { without: ['session_finish'], keep: [] },
  internal: { without: ['session_finish', 'after_current_work'], keep: [] },
  session: { without: ['session_start', 'project_set_current', 'after_current_work'], keep: ['todo_write'] },
  subagent: {
    without: [
      'session_start',
      'session_finish',
      'project_set_current',
      'after_current_work',
      'ask_user',
      'request_secret',
      'plan_write',
      'plan_submit',
      'todo_write',
      'subagent',
      'create_bot',
      'update_bot',
      'delete_bot',
      'create_group',
      'add_member',
      'remove_member',
      'update_own_prompt',
      'set_model',
      'share_file',
      'routine_create',
      'routine_update',
      'routine_delete',
      'project_create',
      'project_update',
      'board_create',
      'board_update',
      'board_delete',
      ...mcpServerTools.names.filter((name) => name !== 'mcp_server_list'),
    ],
    keep: [],
  },
}

/** Whether a lane offers a tool at all (skills aside). External MCP tools are not offered to read-only helpers. */
export function toolAllowedInLane(name: string, lane: LaneKind, readOnly = false): boolean {
  if (!isToolName(name)) return !readOnly
  if (readOnly && !READ_ONLY_HELPER_TOOLS.includes(name)) return false
  return !LANE_TOOLS[lane].without.includes(name)
}

export interface ToolSetOptions {
  /** Tools a CLI engine does natively (`CliEngineDriver.nativeInMcp`): left out of its lane's set. */
  native?: readonly ToolName[]
  /** A helper that must not change files. */
  readOnly?: boolean
  /** Families enabled by the bot's active skills; absent: every family. */
  enabledFamilies?: ReadonlySet<string>
}

/** Whether the bot's active skills allow a tool in a lane (tools outside every family always are). */
export function toolEnabled(name: string, lane: LaneKind, enabledFamilies?: ReadonlySet<string>): boolean {
  if (!enabledFamilies) return true
  const family = toolFamily(name)
  if (!family || enabledFamilies.has(family)) return true
  return (LANE_TOOLS[lane].keep as string[]).includes(name)
}

/** Tools of one lane of a bot (see `lanes.ts`). */
export function toolsForLane(lane: LaneKind, options: ToolSetOptions = {}): ToolDefinition[] {
  return (Object.keys(TOOL_DEFINITIONS) as ToolName[])
    .filter((name) => !options.native?.includes(name))
    .filter((name) => toolAllowedInLane(name, lane, options.readOnly))
    .filter((name) => toolEnabled(name, lane, options.enabledFamilies))
    .map((name) => TOOL_DEFINITIONS[name])
}

/** Tool names models borrow from other harnesses, and the tool that does the same here. */
const TOOL_ALIASES: Record<string, ToolName> = {
  write: 'file_write',
  create_file: 'file_write',
  edit: 'file_edit',
  str_replace: 'file_edit',
  multiedit: 'file_edit',
  read: 'file_read',
  view: 'file_read',
  shell: 'bash',
  exec: 'bash',
  grep: 'bash',
  glob: 'bash',
  ls: 'bash',
}

/** The tool a name borrowed from another harness stands for, if any. */
export function toolAlias(name: string): ToolName | undefined {
  return TOOL_ALIASES[name.toLowerCase()]
}
