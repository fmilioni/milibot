import { CLI_ENGINE_INFO } from '@milibot/shared'

import type { CliEngineDriver } from '../cli/engine'
import { cliRotationSettings } from '../cli/settings'
import { CODEX_PROC_LABEL } from './config'
import { describeCodexTool } from './items'
import { codexMcpConfig } from './mcp'
import { codexProfile, ESTIMATED_CODEX_BASE_TOKENS } from './profile'
import type { RateLimitSnapshot } from './protocol'
import { CodexSessions } from './sessions'
import { mergeCodexRateLimits } from './usage'

/** `codex app-server` over JSON-RPC, one process and thread per lane (see `CodexSessions`). */
export const codexDriver: CliEngineDriver = {
  id: 'codex',
  displayName: CLI_ENGINE_INFO.codex.displayName,
  procLabel: CODEX_PROC_LABEL,
  // Codex keeps its web search and fetches pages through Milibot's `web_fetch`.
  nativeInMcp: ['bash', 'file_read', 'file_write', 'file_edit', 'grep', 'glob', 'apply_patch', 'web_search'],
  wording: {
    nativeTools: 'shell and apply_patch',
    // Codex has its own ways to ask the user and spawn agents, which Milibot does not run.
    toolRule:
      ' Ask the user with ask_user and hand work to helpers with subagent, never request_user_input or spawn_agent.',
    sessionTools:
      'search with `rg` and read only the lines you need (`sed -n`). Change files with apply_patch instead of rewriting them.',
    helperSearch: '`rg`',
  },
  lightModel: CLI_ENGINE_INFO.codex.lightModel,
  settings: (get) => ({ ...cliRotationSettings('codex', get), systemPrompt: null }),
  estimatedBaseTokens: () => ESTIMATED_CODEX_BASE_TOKENS,
  nativeTools: () => null,
  profile: codexProfile,
  externalMcp: codexMcpConfig,
  describeTool: describeCodexTool,
  mergeQuota: (previous, providerId, update, now) =>
    mergeCodexRateLimits(previous, providerId, update as RateLimitSnapshot, now),
  createSessions: (backend, log, timing) => new CodexSessions(backend, log, timing),
}
