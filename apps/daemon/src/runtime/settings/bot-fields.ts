import type { WorkspacePreferences } from '@milibot/shared'

type BotSettingKind = 'flag' | 'number' | 'text' | 'choice' | 'bot' | 'bots' | 'model' | 'image_model' | 'usd'

interface BotSettingField {
  kind: BotSettingKind
  /** Applied only after the user approves it on a confirmation card. */
  confirm: boolean
  about: string
}

/**
 * The preferences a bot may read and change (`workspace_settings_*`). Spend limits, merging and how prompt
 * changes are applied widen what bots may do on their own, so they wait for the user's confirmation.
 */
export const BOT_SETTING_FIELDS = {
  notifications: { kind: 'flag', confirm: false, about: 'desktop notifications' },
  notifyRoutines: {
    kind: 'choice',
    confirm: false,
    about: 'finished routines notify "always", or only when they failed ("attention")',
  },
  mutedBots: { kind: 'bots', confirm: false, about: 'bots whose notifications are off (the whole list)' },
  maxParallelBots: { kind: 'number', confirm: false, about: 'bots working at the same time' },
  idleWatchMinutes: {
    kind: 'number',
    confirm: false,
    about: 'minutes a stopped bot may hold set-aside requests before idleWatchBotId is told (0 = off)',
  },
  idleWatchBotId: {
    kind: 'bot',
    confirm: false,
    about: 'bot told about idle bots (null = the first bot)',
  },
  idleWatchFallback: {
    kind: 'choice',
    confirm: false,
    about: 'who is told when the idle bot is idleWatchBotId itself: "next_bot" of the team or the "user"',
  },
  perBotLimits: { kind: 'flag', confirm: false, about: "caps on each bot's CPU and memory in the VM" },
  perBotCpuPercent: { kind: 'number', confirm: false, about: 'CPU cap per bot, % of one core' },
  perBotMemoryGb: { kind: 'number', confirm: false, about: 'memory cap per bot, GB' },
  newBotModel: { kind: 'model', confirm: false, about: 'model of bots created without one' },
  triageModel: { kind: 'model', confirm: false, about: 'decides who answers in groups (null = automatic)' },
  summaryModel: { kind: 'model', confirm: false, about: 'summarizes conversations (null = automatic)' },
  knowledgeSummaryModel: {
    kind: 'model',
    confirm: false,
    about: 'summarizes documents (null = automatic)',
  },
  fallbackModel: {
    kind: 'model',
    confirm: false,
    about: "used when a bot's provider fails or its quota ran out (null = none)",
  },
  imageModel: {
    kind: 'image_model',
    confirm: false,
    about: 'what generate_image draws with (null = the first enabled)',
  },
  commitName: { kind: 'text', confirm: false, about: 'git author name; {bot} = bot name, {slug} = bot slug' },
  commitEmail: { kind: 'text', confirm: false, about: 'git author email; {slug} = bot slug' },
  draftPrs: { kind: 'flag', confirm: false, about: 'open pull requests as drafts' },
  routinesCatchUp: {
    kind: 'choice',
    confirm: false,
    about: 'routine runs missed while off: run "once" or "skip"',
  },
  legacyOffice: { kind: 'flag', confirm: false, about: 'read .doc/.xls/.ppt/.ods/.odp in the VM' },
  vmAutostart: { kind: 'flag', confirm: false, about: 'boot the VM when the workspace opens' },
  spendWarnUsd: {
    kind: 'usd',
    confirm: true,
    about: "warn in the chat when today's spend passes it (USD; null = never)",
  },
  spendPauseUsd: {
    kind: 'usd',
    confirm: true,
    about: "pause every bot for the day when today's spend reaches it (USD; null = never)",
  },
  autoMergePrs: { kind: 'flag', confirm: true, about: 'bots may merge their own pull requests' },
  promptUpdates: {
    kind: 'choice',
    confirm: true,
    about: 'bot persona changes apply "auto" (with a note) or wait for the user\'s "approval"',
  },
} as const satisfies Partial<Record<keyof WorkspacePreferences, BotSettingField>>

export type BotSettingName = keyof typeof BOT_SETTING_FIELDS

export const BOT_SETTING_NAMES = Object.keys(BOT_SETTING_FIELDS) as BotSettingName[]

/** Preferences only the user changes, in Settings. */
export const USER_ONLY_SETTINGS = [
  'payloadRetentionDays',
  'screenshotRetentionDays',
  'userLanguage',
] as const satisfies ReadonlyArray<Exclude<keyof WorkspacePreferences, BotSettingName>>

export function isBotSetting(name: string): name is BotSettingName {
  return Object.hasOwn(BOT_SETTING_FIELDS, name)
}
