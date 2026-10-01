/**
 * Query keys. Workspace data lives under `['ws', workspaceId, <area>, …]`, app data under `['app', …]`:
 * invalidating a prefix refetches everything under it (`cache-updates.ts` maps events to prefixes).
 */
export const workspaceKey = (workspaceId: string, ...parts: unknown[]) => ['ws', workspaceId, ...parts]

export const queryKeys = {
  workspace: (workspaceId: string) => workspaceKey(workspaceId),

  providers: (workspaceId: string) => workspaceKey(workspaceId, 'providers'),
  /** A provider's saved chat, search and image models. */
  providerModels: (workspaceId: string, providerId: string) =>
    workspaceKey(workspaceId, 'providers', providerId, 'models'),
  providerAccount: (workspaceId: string, providerId: string) =>
    workspaceKey(workspaceId, 'providers', providerId, 'account'),
  automaticModels: (workspaceId: string, prefs: string) =>
    workspaceKey(workspaceId, 'providers', 'automatic', prefs),
  /** The CLI Milibot installs in the VM for an engine; without `engine`, every engine's. */
  cliInstall: (workspaceId: string, engine?: string) =>
    workspaceKey(workspaceId, 'providers', 'cli-install', ...(engine ? [engine] : [])),
  cliLogin: (workspaceId: string, engine: string) => workspaceKey(workspaceId, 'providers', 'login', engine),

  routines: (workspaceId: string, botId: string) => workspaceKey(workspaceId, 'routines', botId),
  procedures: (workspaceId: string, botId: string) => workspaceKey(workspaceId, 'procedures', botId),
  botMemories: (workspaceId: string, botId: string) => workspaceKey(workspaceId, 'memories', 'bot', botId),
  workspaceMemories: (workspaceId: string) => workspaceKey(workspaceId, 'memories', 'workspace'),
  promptVersions: (workspaceId: string, botId: string) => workspaceKey(workspaceId, 'prompt-versions', botId),
  botDisplay: (workspaceId: string, botId: string) => workspaceKey(workspaceId, 'bot-display', botId),

  attachmentSettings: (workspaceId: string) => workspaceKey(workspaceId, 'attachment-settings'),
  costs: (workspaceId: string, ...parts: unknown[]) => workspaceKey(workspaceId, 'costs', ...parts),
  debugStorage: (workspaceId: string) => workspaceKey(workspaceId, 'debug', 'storage'),
  spendStatus: (workspaceId: string) => workspaceKey(workspaceId, 'spend'),
  credentials: (workspaceId: string, kind: 'github' | 'web-search' | 'secrets' | 'ssh') =>
    workspaceKey(workspaceId, 'credentials', kind),
  backupJob: (workspaceId: string) => workspaceKey(workspaceId, 'backup', 'job'),
  backupRestore: (workspaceId: string) => workspaceKey(workspaceId, 'backup', 'restore'),
  vmDetails: (workspaceId: string) => workspaceKey(workspaceId, 'vm', 'details'),

  conversationDebug: (workspaceId: string, conversationId: string) =>
    workspaceKey(workspaceId, 'debug', 'conversation', conversationId),
  conversationSummaries: (workspaceId: string, conversationId: string, botId: string) =>
    workspaceKey(workspaceId, 'debug', 'summaries', conversationId, botId),
  llmCall: (workspaceId: string, callId: string) => workspaceKey(workspaceId, 'debug', 'llm-call', callId),
  toolCalls: (workspaceId: string, conversationId: string, turnId: string) =>
    workspaceKey(workspaceId, 'debug', 'tool-calls', conversationId, turnId),
  toolCallDiff: (workspaceId: string, toolCallId: string) =>
    workspaceKey(workspaceId, 'debug', 'tool-call-diff', toolCallId),

  blob: (workspaceId: string, sha: string) => workspaceKey(workspaceId, 'blob', sha),
  skill: (workspaceId: string, skillId: string) => workspaceKey(workspaceId, 'skills', skillId),
  skillUsage: (workspaceId: string, skillId: string) => workspaceKey(workspaceId, 'skills', skillId, 'usage'),
  knowledgeContent: (workspaceId: string, docId: string, part: unknown) =>
    workspaceKey(workspaceId, 'knowledge', docId, 'content', part),
  designFrameSource: (workspaceId: string, designId: string, frameId: string) =>
    workspaceKey(workspaceId, 'designs', designId, 'frames', frameId, 'source'),
  design: (workspaceId: string, designId: string) => workspaceKey(workspaceId, 'designs', designId),
  plan: (workspaceId: string, planId: string) => workspaceKey(workspaceId, 'plans', planId),
  session: (workspaceId: string, sessionId: string) => workspaceKey(workspaceId, 'sessions', sessionId),
  boardCard: (workspaceId: string, boardId: string, cardId: string) =>
    workspaceKey(workspaceId, 'boards', boardId, 'cards', cardId),

  workspaceOverviews: () => ['app', 'workspaces', 'overviews'],
  openWorkspaces: () => ['app', 'workspaces', 'open'],
}
