import type { ResolvedModel } from '@milibot/agent'
import { pullRequestNote } from '@milibot/agent/prompts'
import {
  type AutomaticModel,
  type Bot,
  type CliUsage,
  type Language,
  type LogFn,
  type ModelChoice,
  PREFERENCE_SETTING_KEYS,
  type preferenceEndpoints,
  type UpdateWorkspacePreferencesBody,
  type WorkspaceEvent,
  type WorkspacePreferences,
} from '@milibot/shared'
import type { z } from 'zod'

import { errorMessage } from '../../errors'
import type { EndpointHandlers } from '../../handlers'
import type { CredentialService } from '../credentials'
import {
  type AutomaticResolution,
  createModelPolicy,
  type ModelCatalog,
  type ProviderStore,
} from '../providers'
import type { SpendGuard } from '../spend'
import type { VmController } from '../vm'
import type { WorkspaceStore } from '../workspace-store'
import type { GitPolicySync } from './git-policy'
import type { OfficeService } from './office'
import { planMergeAllowed, readPreferences } from './preferences'

export interface SettingsDeps {
  store: WorkspaceStore
  providers: Pick<ProviderStore, 'exists' | 'get'>
  catalog: ModelCatalog
  vm: Pick<VmController, 'applyBotLimits'>
  credentials: Pick<CredentialService, 'botEnv' | 'github'>
  spend: Pick<SpendGuard, 'check'>
  office: Pick<OfficeService, 'sync'>
  gitPolicy: Pick<GitPolicySync, 'refresh'>
  /** Latest subscription quota of a CLI provider (Claude Code, Codex). */
  cliUsage: (providerId: string) => CliUsage | null
  emit: (event: WorkspaceEvent) => void
  now: () => number
  log: LogFn
}

/** The workspace preferences and what the agent environment derives from them. */
export class SettingsService {
  constructor(private readonly deps: SettingsDeps) {}

  preferences(): WorkspacePreferences {
    const { settings } = this.deps.store
    return readPreferences((key, fallback) => settings.get(key, fallback))
  }

  /**
   * Saves a validated patch, applies what depends on it (spend check, commit identity, VM limits, office,
   * git policy) and tells the app: the settings screen, a bot's tool and an approved card all come here.
   */
  update(patch: z.output<typeof UpdateWorkspacePreferencesBody>): WorkspacePreferences {
    const { store, spend, credentials, vm, office, gitPolicy, log } = this.deps
    store.settings.setMany(PREFERENCE_SETTING_KEYS, patch)
    if (patch.spendWarnUsd !== undefined || patch.spendPauseUsd !== undefined) spend.check()
    if (patch.commitName !== undefined || patch.commitEmail !== undefined)
      void credentials.github.syncVm({ touchLogin: false }).catch(() => undefined)
    if (
      patch.perBotLimits !== undefined ||
      patch.perBotCpuPercent !== undefined ||
      patch.perBotMemoryGb !== undefined
    )
      void vm
        .applyBotLimits()
        .catch((err: unknown) => log('warn', 'bot limits not applied', { err: errorMessage(err) }))
    if (patch.legacyOffice !== undefined) void office.sync()
    if (patch.draftPrs !== undefined || patch.autoMergePrs !== undefined) gitPolicy.refresh()
    const preferences = this.preferences()
    this.deps.emit({ type: 'preferences.updated', payload: { preferences } })
    return preferences
  }

  /** Adds a bot's variables and commit identity to a CLI engine's process environment. */
  async withBotEnv(resolved: ResolvedModel, bot: Bot): Promise<ResolvedModel> {
    if (resolved.kind !== 'cli') return resolved
    return { ...resolved, env: { ...(await this.deps.credentials.botEnv(bot)), ...resolved.env } }
  }

  async fallbackModel(bot: Bot): Promise<ResolvedModel | null> {
    const choice = this.preferences().fallbackModel
    if (!choice) return null
    const resolved = await this.deps.catalog.resolveChoice(choice).catch(() => null)
    return resolved && resolved.kind !== 'unavailable' ? this.withBotEnv(resolved, bot) : null
  }

  providerExhausted(providerId: string): boolean {
    const usage = this.deps.cliUsage(providerId)
    if (!usage || usage.status.startsWith('allowed')) return false
    return usage.resetsAt === null || usage.resetsAt > this.deps.now()
  }

  /**
   * The workspace's pull request rules (code-and-repos skill); with a plan, what that plan may do (its
   * execution note and its session's brief).
   */
  pullRequestNote(plan?: { mergePr: boolean | null }): string {
    const prefs = this.preferences()
    return pullRequestNote({
      draftPrs: prefs.draftPrs,
      autoMergePrs: prefs.autoMergePrs,
      mergeAllowed: plan ? planMergeAllowed(plan, prefs.autoMergePrs) : undefined,
    })
  }

  userLanguage(): Language {
    return this.preferences().userLanguage
  }

  /** Provider + model for a bot created without one. */
  newBotModel(): ModelChoice | null {
    const choice = this.preferences().newBotModel
    return choice && this.deps.providers.exists(choice.providerId) ? choice : null
  }

  private async describe({ model, source }: AutomaticResolution): Promise<AutomaticModel | null> {
    if (model.kind === 'unavailable' || !model.providerId || !model.model) return null
    const provider = await this.deps.providers.get(model.providerId)
    return {
      providerId: provider.id,
      providerName: provider.name,
      model: model.model,
      displayName: this.deps.catalog.modelDisplayName(provider.id, model.model),
      source,
    }
  }

  handlers(): EndpointHandlers<keyof typeof preferenceEndpoints> {
    const { store, catalog } = this.deps
    const models = createModelPolicy(store, catalog)
    return {
      getWorkspacePreferences: () => this.preferences(),
      getAutomaticModels: async () => {
        const bot = store.bots.first()
        if (!bot) return { triageModel: null, summaryModel: null, knowledgeSummaryModel: null }
        const automatic = await this.describe(await models.automatic(bot))
        return {
          triageModel: automatic,
          summaryModel: automatic,
          knowledgeSummaryModel: await this.describe(await models.automaticKnowledgeSummary(bot)),
        }
      },
      updateWorkspacePreferences: ({ body }) => this.update(body),
    }
  }
}
