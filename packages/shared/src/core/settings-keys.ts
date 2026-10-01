import type { CliEngine, CliSettings } from '../models/cli'
import type { VmConfig } from '../vm/vm'

/*
 * Keys of the workspace `settings` table that more than one package reads or writes. Groups are
 * `*_SETTING_KEYS` objects (field → key, so `setSettings(GROUP, body)` maps a body onto them), single keys
 * are `*_KEY`. A group may reuse a key of `PREFERENCE_SETTING_KEYS`; any other value is unique.
 */

/** Backs each field of `WorkspacePreferences`. */
export const PREFERENCE_SETTING_KEYS = {
  notifications: 'notifications.enabled',
  notifyRoutines: 'notifications.routines',
  mutedBots: 'notifications.muted_bots',
  maxParallelBots: 'agents.max_parallel',
  perBotLimits: 'vm.per_bot_limits',
  perBotCpuPercent: 'vm.per_bot_cpu_percent',
  perBotMemoryGb: 'vm.per_bot_memory_gb',
  newBotModel: 'bots.default_model',
  triageModel: 'groups.triage_model',
  summaryModel: 'memory.summary_model',
  knowledgeSummaryModel: 'knowledge.summary_model',
  fallbackModel: 'agents.fallback_model',
  imageModel: 'images.default_model',
  spendWarnUsd: 'spend.warn_usd_per_day',
  spendPauseUsd: 'spend.pause_usd_per_day',
  payloadRetentionDays: 'debug.payload_retention_days',
  screenshotRetentionDays: 'debug.screenshot_retention_days',
  commitName: 'git.commit_name',
  commitEmail: 'git.commit_email',
  draftPrs: 'git.draft_prs',
  autoMergePrs: 'git.auto_merge_prs',
  routinesCatchUp: 'routines.catch_up',
  promptUpdates: 'prompts.update_mode',
  legacyOffice: 'office.legacy_formats',
  userLanguage: 'user.language',
} as const

/** The VM size the user chose. */
export const VM_SETTING_KEYS = {
  cpus: 'vm.vcpus',
  memGb: 'vm.memory_gb',
  dataGb: 'vm.data_disk_gb',
  systemGb: 'vm.system_disk_gb',
} as const satisfies Record<keyof VmConfig, string>

export const KNOWLEDGE_SETTING_KEYS = {
  embedding: 'knowledge.embedding',
  autoRetrieve: 'knowledge.auto_retrieve',
  suggestDocs: 'knowledge.suggest_docs',
  catalogBudgetTokens: 'knowledge.catalog_budget_tokens',
} as const

/** Group routing and bot-to-bot messaging. */
export const GROUP_SETTING_KEYS = {
  triageModel: PREFERENCE_SETTING_KEYS.triageModel,
  /** A bot that spoke in a group less than this ago is not woken by other bots' messages. */
  botCooldownSeconds: 'groups.bot_cooldown_seconds',
  /** How long ask_bot waits before the reply turns into a later message. */
  askTimeoutSeconds: 'bots.ask_timeout_seconds',
  /** delete_bot requested by a bot waits for the user's confirmation. */
  confirmBotDeletion: 'bots.confirm_delete',
} as const

/** Context budgets of `MemorySettings`. */
export const MEMORY_SETTING_KEYS = {
  summaryModel: PREFERENCE_SETTING_KEYS.summaryModel,
  tailBudgetTokens: 'memory.tail_budget_tokens',
  memoryBudgetTokens: 'memory.memory_budget_tokens',
  workspaceMemoryBudgetTokens: 'memory.workspace_budget_tokens',
  summaryBudgetTokens: 'memory.summary_budget_tokens',
  retrievedBudgetTokens: 'memory.retrieved_budget_tokens',
} as const

/** The `CliSettings` of an engine, stored under its id (`claude_code.rotate_idle_minutes`). */
export function cliSettingKeys(engine: CliEngine): Record<keyof CliSettings, string> {
  return {
    rotateIdleMinutes: `${engine}.rotate_idle_minutes`,
    rotateContextTokens: `${engine}.rotate_context_tokens`,
    compactSystemPrompt: `${engine}.compact_system_prompt`,
  }
}

export const ATTACHMENT_SETTING_KEYS = {
  maxFileMb: 'attachments.max_file_mb',
} as const

/** When the user last reset the spend counter; history is never touched. */
export const USAGE_COUNTER_RESET_KEY = 'usage.counter_reset_at'

/** How long `ask_user`/`request_secret` wait for the user. */
export const USER_REQUEST_TIMEOUT_KEY = 'bots.user_request_timeout_seconds'
