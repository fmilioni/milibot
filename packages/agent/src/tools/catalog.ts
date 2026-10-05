import type { ToolDefinition } from '../llm/provider'
import { boardTools } from './families/boards'
import { browserTools } from './families/browser'
import { computerTools } from './families/computer'
import { designTools } from './families/design'
import { fileTools } from './families/files'
import { imageTools } from './families/images'
import { knowledgeTools } from './families/knowledge'
import { mcpServerTools } from './families/mcp-servers'
import { memberTools } from './families/members'
import { memoryTools } from './families/memory'
import { messagingTools } from './families/messaging'
import { planTools } from './families/plans'
import { projectTools } from './families/projects'
import { repoTools } from './families/repos'
import { routineTools } from './families/routines'
import { sessionTools } from './families/sessions'
import { sharingTools } from './families/sharing'
import { skillTools } from './families/skills'
import { subagentTools } from './families/subagents'
import { teamTools } from './families/team'
import { userRequestTools } from './families/user-requests'
import { webTools } from './families/web'
import { workspaceSettingsTools } from './families/workspace-settings'

/**
 * Every tool family, in the order models see the tools (a change of order changes every CLI session's
 * profile and the providers' prompt cache). New tools go at the end of their family.
 */
export const TOOL_CATALOG = [
  computerTools,
  browserTools,
  webTools,
  fileTools,
  teamTools,
  repoTools,
  memoryTools,
  knowledgeTools,
  skillTools,
  messagingTools,
  userRequestTools,
  memberTools,
  sharingTools,
  routineTools,
  projectTools,
  planTools,
  sessionTools,
  designTools,
  boardTools,
  imageTools,
  subagentTools,
  workspaceSettingsTools,
  mcpServerTools,
] as const

export const TOOL_DEFINITIONS = {
  ...computerTools.definitions,
  ...browserTools.definitions,
  ...webTools.definitions,
  ...fileTools.definitions,
  ...teamTools.definitions,
  ...repoTools.definitions,
  ...memoryTools.definitions,
  ...knowledgeTools.definitions,
  ...skillTools.definitions,
  ...messagingTools.definitions,
  ...userRequestTools.definitions,
  ...memberTools.definitions,
  ...sharingTools.definitions,
  ...routineTools.definitions,
  ...projectTools.definitions,
  ...planTools.definitions,
  ...sessionTools.definitions,
  ...designTools.definitions,
  ...boardTools.definitions,
  ...imageTools.definitions,
  ...subagentTools.definitions,
  ...workspaceSettingsTools.definitions,
  ...mcpServerTools.definitions,
} satisfies Record<string, ToolDefinition>

export type ToolName = keyof typeof TOOL_DEFINITIONS

export const TOOL_NAMES = Object.keys(TOOL_DEFINITIONS) as ToolName[]

export function isToolName(name: string): name is ToolName {
  return Object.hasOwn(TOOL_DEFINITIONS, name)
}
