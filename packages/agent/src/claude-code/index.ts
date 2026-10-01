import { CLI_ENGINE_INFO, type CliUsage } from '@milibot/shared'

import type { CliEngineDriver } from '../cli/engine'
import { COMPACT_SYSTEM_PROMPT } from '../prompts/lanes'
import { CLAUDE_CODE_PROC_LABEL, claudeCodeSettings } from './config'
import { claudeCodeMcpConfig } from './mcp'
import {
  CLAUDE_CODE_READ_ONLY_TOOLS,
  CLAUDE_CODE_SESSION_TOOLS,
  CLAUDE_CODE_TOOLS,
  claudeCodeProfile,
  ESTIMATED_BASE_TOKENS,
} from './profile'
import { ClaudeCodeSessions } from './sessions'
import type { ClaudeRateLimit } from './stream-json'
import { describeClaudeCodeTool } from './tools'

/** `claude -p` in stream-json, one process per lane (see `ClaudeCodeSessions`). */
export const claudeCodeDriver: CliEngineDriver = {
  id: 'claude_code',
  displayName: CLI_ENGINE_INFO.claude_code.displayName,
  procLabel: CLAUDE_CODE_PROC_LABEL,
  // Claude Code keeps its own WebSearch/WebFetch.
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
    nativeTools: 'Bash/Read/Edit/Write',
    toolRule: '',
    sessionTools:
      'search with Grep/Glob and Read only the lines you need (offset/limit). Change files with Edit instead of rewriting them with Write.',
    helperSearch: 'Grep/Glob',
  },
  lightModel: CLI_ENGINE_INFO.claude_code.lightModel,
  settings: (get) => {
    const { compactSystemPrompt, ...rotation } = claudeCodeSettings(get)
    return { ...rotation, systemPrompt: compactSystemPrompt ? COMPACT_SYSTEM_PROMPT : null }
  },
  estimatedBaseTokens: (settings) => ESTIMATED_BASE_TOKENS[settings.systemPrompt ? 'compact' : 'default'],
  nativeTools: ({ inSession, readOnly }) =>
    readOnly ? CLAUDE_CODE_READ_ONLY_TOOLS : inSession ? CLAUDE_CODE_SESSION_TOOLS : CLAUDE_CODE_TOOLS,
  profile: claudeCodeProfile,
  externalMcp: claudeCodeMcpConfig,
  describeTool: describeClaudeCodeTool,
  mergeQuota: (previous, providerId, update, now): CliUsage => ({
    providerId,
    engine: 'claude_code',
    ...(update as ClaudeRateLimit),
    plan: previous?.plan ?? null,
    updatedAt: now,
  }),
  createSessions: (backend, log, timing) => new ClaudeCodeSessions(backend, log, timing),
}
