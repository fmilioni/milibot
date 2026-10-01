import { CLI_ENGINE_INFO, type CliUsageWindow } from '@milibot/shared'

import type { CliEngineDriver } from '../cli/engine'
import { cliRotationSettings } from '../cli/settings'
import { ANTIGRAVITY_PROC_LABEL } from './config'
import { antigravityMcpConfig } from './mcp'
import { antigravityProfile, ESTIMATED_ANTIGRAVITY_BASE_TOKENS } from './profile'
import { AntigravitySessions } from './sessions'
import {
  ANTIGRAVITY_LANE_TOOLS,
  ANTIGRAVITY_READ_ONLY_TOOLS,
  ANTIGRAVITY_SESSION_TOOLS,
  describeAntigravityTool,
} from './tools'
import { antigravityQuota } from './usage'

/** `agy -p` in stream-json, one process per lane (see `AntigravitySessions`). */
export const antigravityDriver: CliEngineDriver = {
  id: 'antigravity',
  displayName: CLI_ENGINE_INFO.antigravity.displayName,
  procLabel: ANTIGRAVITY_PROC_LABEL,
  // agy keeps its own web search and page reader.
  nativeInMcp: [
    'bash',
    'file_read',
    'file_write',
    'file_edit',
    'grep',
    'glob',
    'apply_patch',
    'web_search',
    'web_fetch',
  ],
  wording: {
    nativeTools: 'run_command/view_file/write_to_file/replace_file_content',
    toolRule:
      ' The Milibot tools these rules name are tools of the `milibot` MCP server: call them with call_mcp_tool.',
    sessionTools:
      'search with grep_search/find_by_name and view_file only the lines you need. Change files with replace_file_content instead of rewriting them with write_to_file.',
    helperSearch: 'grep_search/find_by_name',
  },
  lightModel: CLI_ENGINE_INFO.antigravity.lightModel,
  settings: (get) => ({ ...cliRotationSettings('antigravity', get), systemPrompt: null }),
  estimatedBaseTokens: () => ESTIMATED_ANTIGRAVITY_BASE_TOKENS,
  nativeTools: ({ inSession, readOnly }) =>
    readOnly ? ANTIGRAVITY_READ_ONLY_TOOLS : inSession ? ANTIGRAVITY_SESSION_TOOLS : ANTIGRAVITY_LANE_TOOLS,
  profile: antigravityProfile,
  externalMcp: antigravityMcpConfig,
  describeTool: describeAntigravityTool,
  // Only the daemon's `/usage` readings carry windows; the per-turn check (`ANTIGRAVITY_QUOTA_CHECK`) has none.
  mergeQuota: (previous, providerId, update, now) =>
    Array.isArray(update) ? antigravityQuota(previous, providerId, update as CliUsageWindow[], now) : null,
  createSessions: (backend, log, timing) => new AntigravitySessions(backend, log, timing),
}
