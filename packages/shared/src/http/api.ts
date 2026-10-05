import type { z } from 'zod'

import { boardEndpoints } from '../boards/boards'
import { botControlEndpoints } from '../bots/control'
import { botEndpoints } from '../bots/endpoints'
import { promptVersionEndpoints } from '../bots/prompt-versions'
import { setAsideEndpoints } from '../bots/set-aside'
import { attachmentEndpoints } from '../chat/attachments'
import { conversationEndpoints } from '../chat/conversations'
import { groupEndpoints } from '../chat/groups'
import { sidebarEndpoints } from '../chat/sidebar'
import { userRequestEndpoints } from '../chat/user-request-endpoints'
import { costEndpoints } from '../costs/costs'
import { credentialEndpoints } from '../credentials/credentials'
import { debugEndpoints } from '../debug/debug'
import { designEndpoints } from '../designs/designs'
import { knowledgeEndpoints } from '../knowledge/knowledge'
import { officeEndpoints } from '../knowledge/office'
import { mcpEndpoints } from '../mcp/mcp'
import { memoryEndpoints } from '../memory/memory'
import { cliEndpoints, cliEngineEndpoints } from '../models/cli'
import { providerEndpoints } from '../models/providers'
import { procedureEndpoints } from '../procedures/procedures'
import { routineEndpoints } from '../routines/routines'
import { skillEndpoints } from '../skills/skills'
import { vmEndpoints } from '../vm/vm'
import { planEndpoints } from '../work/plans'
import { projectEndpoints } from '../work/projects'
import { workSessionEndpoints } from '../work/sessions'
import { backupEndpoints } from '../workspace/backup'
import { preferenceEndpoints } from '../workspace/preferences'
import { setupEndpoints } from '../workspace/setup'
import { workspaceEndpoints } from '../workspace/workspace'
import { daemonEndpoints } from './daemon-info'
import { defineApi } from './endpoint'
import type { PathParams } from './path'

export const api = defineApi(
  daemonEndpoints,
  workspaceEndpoints,
  setupEndpoints,
  backupEndpoints,
  preferenceEndpoints,
  botEndpoints,
  botControlEndpoints,
  promptVersionEndpoints,
  setAsideEndpoints,
  conversationEndpoints,
  sidebarEndpoints,
  groupEndpoints,
  userRequestEndpoints,
  attachmentEndpoints,
  providerEndpoints,
  cliEndpoints,
  cliEngineEndpoints,
  projectEndpoints,
  planEndpoints,
  workSessionEndpoints,
  designEndpoints,
  boardEndpoints,
  routineEndpoints,
  knowledgeEndpoints,
  officeEndpoints,
  memoryEndpoints,
  skillEndpoints,
  procedureEndpoints,
  mcpEndpoints,
  credentialEndpoints,
  vmEndpoints,
  costEndpoints,
  debugEndpoints,
)

export type Api = typeof api
export type EndpointName = keyof Api

export type EndpointParams<N extends EndpointName> = PathParams<Api[N]['path']> &
  (Api[N]['params'] extends z.ZodType ? z.output<Api[N]['params']> : unknown)
export type EndpointBody<N extends EndpointName> = Api[N]['body'] extends z.ZodType
  ? z.input<Api[N]['body']>
  : undefined
export type EndpointQuery<N extends EndpointName> = Api[N]['query'] extends z.ZodType
  ? z.input<Api[N]['query']>
  : undefined
export type EndpointResponse<N extends EndpointName> = z.infer<Api[N]['response']>
