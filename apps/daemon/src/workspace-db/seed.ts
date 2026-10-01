import {
  DEFAULT_VM_CONFIG,
  DEFAULT_WORKSPACE_PREFERENCES,
  FIRST_BOT_DEFAULTS,
  type Language,
  PREFERENCE_SETTING_KEYS,
  VM_SETTING_KEYS,
} from '@milibot/shared'

import type { Db } from '../db/sqlite'
import { ensureSkillRow, setBotSkillPref } from '../runtime/skills/store'
import { WorkspaceStore } from '../runtime/workspace-store'
import { openWorkspaceDb } from './open'

/** Defaults read by later stages (VM manager, agent runtime, retention jobs). */
const DEFAULT_WORKSPACE_SETTINGS: Record<string, unknown> = {
  [VM_SETTING_KEYS.cpus]: DEFAULT_VM_CONFIG.cpus,
  [VM_SETTING_KEYS.memGb]: DEFAULT_VM_CONFIG.memGb,
  [VM_SETTING_KEYS.systemGb]: DEFAULT_VM_CONFIG.systemGb,
  [VM_SETTING_KEYS.dataGb]: DEFAULT_VM_CONFIG.dataGb,
  [PREFERENCE_SETTING_KEYS.maxParallelBots]: DEFAULT_WORKSPACE_PREFERENCES.maxParallelBots,
  [PREFERENCE_SETTING_KEYS.spendWarnUsd]: null,
  [PREFERENCE_SETTING_KEYS.spendPauseUsd]: null,
}

const SEEDED_KEY = 'seed.version'
const SEED_VERSION = 1
const TEAM_MANAGEMENT_SKILL_ID = 'builtin:team-management'

/**
 * The team-management skill is on by default only for the bot it was switched on for: the first bot gets an
 * explicit switch when it is created, so deleting it never hands team management to another bot silently.
 */
function assignTeamManagement(store: WorkspaceStore, botId: string, now = Date.now()): void {
  const skillId = TEAM_MANAGEMENT_SKILL_ID
  ensureSkillRow(store.db, { id: skillId, slug: skillId, source: 'builtin' }, now)
  setBotSkillPref(store.db, { botId, skillId, enabled: true }, now, { keep: true })
}

export interface SeedResult {
  seeded: boolean
  /** The workspace's first (oldest active) bot and its direct conversation. */
  botId: string
  conversationId: string
}

/**
 * Idempotent: creates the first bot (default persona in `language`, team management on), its direct
 * conversation and the default settings once. Every call records `language` (the app's, given on each runtime
 * start) as the user's language.
 */
export function seedWorkspace(store: WorkspaceStore, language: Language): SeedResult {
  return store.db.transaction((): SeedResult => {
    const alreadySeeded = store.settings.get<number>(SEEDED_KEY, 0) >= SEED_VERSION
    let bot = store.bots.first()
    if (!bot) {
      const defaults = FIRST_BOT_DEFAULTS[language]
      bot = store.bots.create({
        name: defaults.name,
        label: defaults.label,
        systemPrompt: defaults.persona,
        avatar: { shape: 'square', color: 'blue', eyes: 'capsule' },
      })
      assignTeamManagement(store, bot.id)
    }
    let conversation = store.conversations.findDirect(bot.id)
    if (!conversation) {
      conversation = store.conversations.create({ type: 'direct', botIds: [bot.id] })
      store.conversations.setPinned(conversation.id, true)
    }
    if (!alreadySeeded) {
      for (const [key, value] of Object.entries(DEFAULT_WORKSPACE_SETTINGS)) store.settings.set(key, value)
      store.settings.set(SEEDED_KEY, SEED_VERSION)
    }
    if (store.settings.get<unknown>(PREFERENCE_SETTING_KEYS.userLanguage, null) !== language)
      store.settings.set(PREFERENCE_SETTING_KEYS.userLanguage, language)
    return { seeded: !alreadySeeded, botId: bot.id, conversationId: conversation.id }
  })()
}

/** Used by the supervisor when a workspace is created, before any runtime process exists. */
export function initWorkspaceDb(path: string, language: Language): SeedResult {
  const db: Db = openWorkspaceDb(path)
  try {
    return seedWorkspace(new WorkspaceStore(db), language)
  } finally {
    db.close()
  }
}
