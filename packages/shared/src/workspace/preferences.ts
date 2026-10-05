import { z } from 'zod'

import { PromptUpdateMode } from '../bots/prompt-versions'
import { endpoint } from '../http/endpoint'
import { ImageModelChoice } from '../models/images'
import { ModelChoice } from '../models/reasoning'
import { RoutineCatchUp } from '../routines/routines'
import { Language } from './workspace'

export const IdleWatchFallback = z.enum(['next_bot', 'user'])
export type IdleWatchFallback = z.infer<typeof IdleWatchFallback>

export const WorkspacePreferences = z.object({
  notifications: z.boolean(),
  /** `attention`: a finished routine notifies only when it failed. */
  notifyRoutines: z.enum(['always', 'attention']),
  /** Bots whose notifications are off. */
  mutedBots: z.array(z.string()).max(500),
  maxParallelBots: z.number().int().min(1).max(10),
  /** Per-bot CPU/memory caps inside the VM (systemd slice of each bot: desktop, commands, CLI engines). */
  perBotLimits: z.boolean(),
  /** CPUQuota of each bot, in percent of one CPU (150 = one and a half cores). */
  perBotCpuPercent: z.number().int().min(25).max(6400),
  /** MemoryMax of each bot. */
  perBotMemoryGb: z.number().int().min(1).max(512),
  /** Model given to bots created without one. */
  newBotModel: ModelChoice.nullable(),
  /** Decides who answers in groups; null = automatic (`AutomaticModels`). */
  triageModel: ModelChoice.nullable(),
  summaryModel: ModelChoice.nullable(),
  knowledgeSummaryModel: ModelChoice.nullable(),
  /** Used when the bot's provider fails or its quota ran out. */
  fallbackModel: ModelChoice.nullable(),
  /** What `generate_image` draws with; null = the first enabled image model. */
  imageModel: ImageModelChoice.nullable(),
  /** Warns in the chat once a day when today's spend passes this. */
  spendWarnUsd: z.number().positive().nullable(),
  /** Holds every bot for the rest of the day when today's spend reaches this. */
  spendPauseUsd: z.number().positive().nullable(),
  payloadRetentionDays: z.number().int().min(1).max(3650),
  screenshotRetentionDays: z.number().int().min(1).max(3650),
  /** Git author name template; `{bot}` = bot name, `{slug}` = bot slug. */
  commitName: z.string().trim().min(1).max(120),
  commitEmail: z.string().trim().min(3).max(200),
  draftPrs: z.boolean(),
  /** Off: bots open the PR and the user merges it (a plan can allow it). */
  autoMergePrs: z.boolean(),
  /** Routine runs missed while the app, the host or the VM was off. */
  routinesCatchUp: RoutineCatchUp,
  /** How a bot's changes to its own (or another bot's) persona are applied. */
  promptUpdates: PromptUpdateMode,
  /** LibreOffice in the VM reads .doc/.xls/.ppt/.ods/.odp (installed on demand). */
  legacyOffice: z.boolean(),
  /** Off: the VM boots only when the user starts it (a VM already running is still adopted). */
  vmAutostart: z.boolean(),
  /**
   * A bot stopped this long with set-aside requests (nothing running, so nothing will wake it) is reported to
   * `idleWatchBotId`; 0 = off.
   */
  idleWatchMinutes: z.number().int().min(0).max(1440),
  /** The bot told about stopped bots (the project manager); null = the first bot. */
  idleWatchBotId: z.string().nullable(),
  /**
   * Who is told when the stopped bot is the one the watch reports to: the next bot of the team, or the user
   * (in the stopped bot's chat). A workspace with no other bot always tells the user.
   */
  idleWatchFallback: IdleWatchFallback,
  /** The app's language, kept in sync by the daemon (not a setting of its own). */
  userLanguage: Language,
})
export type WorkspacePreferences = z.infer<typeof WorkspacePreferences>

export const DEFAULT_WORKSPACE_PREFERENCES: WorkspacePreferences = {
  notifications: true,
  notifyRoutines: 'always',
  mutedBots: [],
  maxParallelBots: 3,
  perBotLimits: false,
  perBotCpuPercent: 150,
  perBotMemoryGb: 3,
  newBotModel: null,
  triageModel: null,
  summaryModel: null,
  knowledgeSummaryModel: null,
  fallbackModel: null,
  imageModel: null,
  spendWarnUsd: null,
  spendPauseUsd: null,
  payloadRetentionDays: 30,
  screenshotRetentionDays: 14,
  commitName: '{bot} (Milibot)',
  commitEmail: '{slug}@milibot.local',
  draftPrs: true,
  autoMergePrs: false,
  routinesCatchUp: 'once',
  promptUpdates: 'auto',
  legacyOffice: false,
  vmAutostart: true,
  idleWatchMinutes: 30,
  idleWatchBotId: null,
  idleWatchFallback: 'next_bot',
  userLanguage: 'pt-BR',
}

export const UpdateWorkspacePreferencesBody = WorkspacePreferences.partial()
export type UpdateWorkspacePreferencesBody = z.input<typeof UpdateWorkspacePreferencesBody>

/** The light model of the bot's provider, the summary model (documents only), or the bot's own model. */
export const AutomaticModelSource = z.enum(['light', 'summary', 'bot'])
export type AutomaticModelSource = z.infer<typeof AutomaticModelSource>

export const AutomaticModel = z.object({
  providerId: z.string(),
  providerName: z.string(),
  model: z.string(),
  displayName: z.string(),
  source: AutomaticModelSource,
})
export type AutomaticModel = z.infer<typeof AutomaticModel>

/** What each side-work field runs on while left on automatic, for the first bot; null = nothing to run on. */
export const AutomaticModels = z.object({
  triageModel: AutomaticModel.nullable(),
  summaryModel: AutomaticModel.nullable(),
  knowledgeSummaryModel: AutomaticModel.nullable(),
})
export type AutomaticModels = z.infer<typeof AutomaticModels>

export const preferenceEndpoints = {
  getWorkspacePreferences: endpoint({
    method: 'GET',
    path: '/w/:workspaceId/preferences',
    response: WorkspacePreferences,
  }),
  updateWorkspacePreferences: endpoint({
    method: 'PATCH',
    path: '/w/:workspaceId/preferences',
    body: UpdateWorkspacePreferencesBody,
    response: WorkspacePreferences,
  }),
  getAutomaticModels: endpoint({
    method: 'GET',
    path: '/w/:workspaceId/preferences/automatic-models',
    response: AutomaticModels,
  }),
}
