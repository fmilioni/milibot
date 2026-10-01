import type { ResolvedModel } from '@milibot/agent'
import {
  type AutomaticModelSource,
  type Bot,
  ModelChoice,
  pickEffort,
  PREFERENCE_SETTING_KEYS,
} from '@milibot/shared'

import type { WorkspaceStore } from '../workspace-store'
import type { ModelCatalog } from './catalog'
import { CLI_ENGINE_HOSTS } from './cli-engines'

export interface AutomaticResolution {
  model: ResolvedModel
  source: AutomaticModelSource
}

type SideWorkKey = 'triageModel' | 'summaryModel' | 'knowledgeSummaryModel'

/**
 * Which model does Milibot's side work (group triage, conversation and document summaries) for a bot: the
 * workspace's choice when set and available, else the automatic one (the light model of the bot's provider,
 * else the bot's own model).
 */
export function createModelPolicy(store: WorkspaceStore, catalog: ModelCatalog) {
  const chosen = async (key: SideWorkKey): Promise<ResolvedModel | null> => {
    const setting = ModelChoice.safeParse(store.settings.get<unknown>(PREFERENCE_SETTING_KEYS[key], null))
    if (!setting.success) return null
    const resolved = await catalog.resolveChoice(setting.data)
    return resolved.kind === 'unavailable' ? null : resolved
  }

  const automatic = async (bot: Bot): Promise<AutomaticResolution> => {
    const own = untuned(await catalog.resolve(bot))
    const light = await catalog.lightModelFor(own)
    return light ? { model: light, source: 'light' } : { model: own, source: 'bot' }
  }

  /** Documents fall back to the conversation summary choice before the bot's own model. */
  const automaticKnowledgeSummary = async (bot: Bot): Promise<AutomaticResolution> => {
    const auto = await automatic(bot)
    if (auto.source === 'light') return auto
    const summary = await chosen('summaryModel')
    return summary ? { model: summary, source: 'summary' } : auto
  }

  return {
    automatic,
    automaticKnowledgeSummary,

    async summaryModel(bot: Bot): Promise<ResolvedModel> {
      return (await chosen('summaryModel')) ?? (await automatic(bot)).model
    },

    /** Triage runs for the first candidate's provider. */
    async triageModel(candidates: Bot[]): Promise<ResolvedModel> {
      return (await chosen('triageModel')) ?? (await automatic(candidates[0] as Bot)).model
    },

    async knowledgeSummaryModel(bot: Bot): Promise<ResolvedModel> {
      return (await chosen('knowledgeSummaryModel')) ?? (await automaticKnowledgeSummary(bot)).model
    },
  }
}

export type ModelPolicy = ReturnType<typeof createModelPolicy>

/** Side work on a bot's own model does not take the effort and output cap chosen for its turns. */
function untuned(resolved: ResolvedModel): ResolvedModel {
  return resolved.kind === 'unavailable' ? resolved : { ...resolved, effort: null, maxOutputTokens: null }
}

/** The one piece of side work not at `low`: the drawing is what the user sees. */
export function forDrawing(resolved: ResolvedModel): ResolvedModel {
  if (resolved.kind === 'unavailable') return resolved
  if (resolved.kind === 'cli')
    return {
      ...resolved,
      effort: pickEffort('high', CLI_ENGINE_HOSTS[resolved.engine].efforts(resolved.model)),
    }
  return { ...resolved, effort: 'high', maxOutputTokens: null }
}
