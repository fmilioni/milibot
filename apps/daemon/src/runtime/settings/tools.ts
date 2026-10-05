import type { ModelRequest, ModelRequestResult, ToolExecContext, ToolResult } from '@milibot/agent'
import { optionalString, type ToolArgs, ToolInputError, toolText } from '@milibot/agent/tools'
import {
  type Bot,
  type ImageModelChoice,
  type ModelChoice,
  UpdateWorkspacePreferencesBody,
  type WorkspacePreferences,
} from '@milibot/shared'

import { type CatalogProvider } from '../providers'
import { resolveByRef, type ToolHandlers, ToolSwitch } from '../tools-core'
import type { SettingChange, SettingChanges } from './bot-changes'
import {
  BOT_SETTING_FIELDS,
  BOT_SETTING_NAMES,
  type BotSettingName,
  isBotSetting,
  USER_ONLY_SETTINGS,
} from './bot-fields'
import type { SettingsService } from './service'

export interface WorkspaceSettingsToolsDeps {
  settings: Pick<SettingsService, 'preferences' | 'update'>
  changes: Pick<SettingChanges, 'propose'>
  listBots: () => Bot[]
  /** The chat models the bot can name, its own provider first. */
  catalog: (bot: Bot | null) => CatalogProvider[]
  resolveModel: (bot: Bot, request: ModelRequest) => ModelRequestResult
  /** Enabled image models. */
  imageModels: () => Array<{ providerId: string; modelId: string; displayName: string; providerName: string }>
}

const NONE = /^\s*(null|none|auto|automatic|default|off)\s*$/i

const sameValue = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)

/** `workspace_settings_*`: the bot reads and changes the workspace preferences allowed to bots. */
export class WorkspaceSettingsTools extends ToolSwitch {
  readonly name = 'workspace settings'
  protected readonly handlers: ToolHandlers = {
    workspace_settings_get: (ctx) => toolText(this.listText(ctx.bot)),
    workspace_settings_update: (ctx, a) => this.update(ctx, a),
  }

  constructor(private readonly deps: WorkspaceSettingsToolsDeps) {
    super()
  }

  private allowedText(): string {
    return (
      `Fields you may change: ${BOT_SETTING_NAMES.join(', ')} (workspace_settings_get shows them). ` +
      `${USER_ONLY_SETTINGS.join(', ')} only the user changes, in Settings.`
    )
  }

  /** A value as the bot reads it: bot and model names instead of ids. */
  valueText(bot: Bot | null, field: BotSettingName, value: unknown): string {
    const kind = BOT_SETTING_FIELDS[field].kind
    if (value === null || value === undefined)
      return kind === 'usd' ? 'null (no limit)' : kind === 'image_model' ? 'null (first enabled)' : 'null'
    if (kind === 'bots') {
      const bots = this.deps.listBots()
      const names = (value as string[]).map((id) => bots.find((b) => b.id === id)?.name ?? id)
      return names.length ? JSON.stringify(names) : '[]'
    }
    if (kind === 'bot') return JSON.stringify(this.deps.listBots().find((b) => b.id === value)?.name ?? value)
    if (kind === 'model') {
      const choice = value as ModelChoice
      const provider = this.deps.catalog(bot).find((p) => p.provider.id === choice.providerId)
      const model = provider?.models.find((m) => m.modelId === choice.model)
      const extras = [
        provider?.provider.name ?? choice.providerId,
        choice.effort ? `effort ${choice.effort}` : null,
        choice.contextLimit ? `context ${choice.contextLimit}` : null,
      ].filter(Boolean)
      return `${model?.modelId ?? choice.model ?? 'provider default'} (${extras.join(', ')})`
    }
    if (kind === 'image_model') {
      const choice = value as ImageModelChoice
      const found = this.deps
        .imageModels()
        .find((m) => m.providerId === choice.providerId && m.modelId === choice.model)
      return found ? `${found.modelId} (${found.providerName})` : `${choice.model} (not enabled)`
    }
    return JSON.stringify(value)
  }

  describe(bot: Bot | null, change: SettingChange): string {
    return `${change.field} ${this.valueText(bot, change.field, change.from)} → ${this.valueText(bot, change.field, change.to)}`
  }

  private listText(bot: Bot): string {
    const prefs = this.deps.settings.preferences()
    const lines = BOT_SETTING_NAMES.map((field) => {
      const { about, confirm } = BOT_SETTING_FIELDS[field]
      return `- ${field} = ${this.valueText(bot, field, prefs[field])}: ${about}${confirm ? ' [needs confirmation]' : ''}`
    })
    return [
      'Workspace preferences you may change with workspace_settings_update ([needs confirmation]: applied ' +
        'only after the user approves a card in the chat):',
      ...lines,
      `Only the user changes ${USER_ONLY_SETTINGS.join(', ')} (in Settings).`,
    ].join('\n')
  }

  private botIds(value: unknown): string[] {
    if (!Array.isArray(value) || value.some((v) => typeof v !== 'string'))
      throw new ToolInputError('mutedBots: give the list of bot names (an empty list unmutes every bot)')
    return [...new Set((value as string[]).map((ref) => this.botId('mutedBots', ref)))]
  }

  private botId(field: BotSettingName, ref: string): string {
    const match = resolveByRef(this.deps.listBots(), ref, {
      id: (b) => b.id,
      names: (b) => [b.name, b.slug],
      ambiguous: { exact: 'first', partial: 'report' },
    })
    if ('found' in match) return match.found.id
    throw new ToolInputError(`${field}: no single bot matches "${ref}" (list_bots shows them)`)
  }

  private modelChoice(bot: Bot, field: BotSettingName, value: unknown): ModelChoice | null {
    if (value === null || (typeof value === 'string' && NONE.test(value))) return null
    const request: ModelRequest | null =
      typeof value === 'string'
        ? { model: value }
        : value && typeof value === 'object' && !Array.isArray(value)
          ? (() => {
              const v = value as ToolArgs
              const text = (key: string) => (typeof v[key] === 'string' ? (v[key] as string) : null)
              return {
                model: text('model'),
                effort: text('effort'),
                provider: text('provider'),
                context: typeof v.context === 'number' ? v.context : text('context'),
              }
            })()
          : null
    if (!request?.model?.trim())
      throw new ToolInputError(
        `${field}: give a model name or id (list_models), {model, effort?, provider?}, or null`,
      )
    const result = this.deps.resolveModel(bot, request)
    if (!result.ok) throw new ToolInputError(`${field}: ${result.error}`)
    return result.choice
  }

  private imageChoice(value: unknown): ImageModelChoice | null {
    if (value === null || (typeof value === 'string' && NONE.test(value))) return null
    if (typeof value !== 'string' || !value.trim())
      throw new ToolInputError('imageModel: give an image model name or id, or null')
    const wanted = value.trim().toLowerCase()
    const models = this.deps.imageModels()
    const found =
      models.find((m) => m.modelId.toLowerCase() === wanted) ??
      models.find((m) => m.displayName.toLowerCase() === wanted) ??
      models.find((m) => m.modelId.toLowerCase().endsWith(`/${wanted}`))
    if (!found)
      throw new ToolInputError(
        models.length
          ? `imageModel: no enabled image model "${value}". Enabled: ${models.map((m) => m.modelId).join(', ')}`
          : 'imageModel: no image model is enabled (the user adds one in Settings → Providers)',
      )
    return { providerId: found.providerId, model: found.modelId }
  }

  /** What the bot wrote, in the shape the preferences store (names → ids, model requests → choices). */
  private convert(bot: Bot, field: BotSettingName, value: unknown): unknown {
    switch (BOT_SETTING_FIELDS[field].kind) {
      case 'bots':
        return this.botIds(value)
      case 'bot':
        if (value === null || (typeof value === 'string' && NONE.test(value))) return null
        if (typeof value !== 'string') throw new ToolInputError(`${field}: give a bot name, or null`)
        return this.botId(field, value)
      case 'model':
        return this.modelChoice(bot, field, value)
      case 'image_model':
        return this.imageChoice(value)
      case 'usd':
        return typeof value === 'string' && NONE.test(value) ? null : value
      default:
        return value
    }
  }

  /** The patch, checked with the schema the settings API validates with. */
  private patch(bot: Bot, raw: Record<string, unknown>): Partial<WorkspacePreferences> {
    const unknown = Object.keys(raw).filter((key) => !isBotSetting(key))
    if (unknown.length)
      throw new ToolInputError(
        `${unknown.map((k) => `"${k}"`).join(', ')} ${unknown.length > 1 ? 'are' : 'is'} not a setting you ` +
          `can change. ${this.allowedText()}`,
      )
    const converted = Object.fromEntries(
      Object.entries(raw).map(([key, value]) => [key, this.convert(bot, key as BotSettingName, value)]),
    )
    const parsed = UpdateWorkspacePreferencesBody.safeParse(converted)
    if (!parsed.success)
      throw new ToolInputError(
        parsed.error.issues
          .map((issue) => `${issue.path.map(String).join('.') || 'settings'}: ${issue.message}`)
          .join('; '),
      )
    return parsed.data
  }

  private async update(ctx: ToolExecContext, a: ToolArgs): Promise<ToolResult> {
    const raw = a.settings
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).length === 0)
      throw new ToolInputError(
        '"settings" must be an object of {field: value}, e.g. {"maxParallelBots": 4}. ' + this.allowedText(),
      )
    const patch = this.patch(ctx.bot, raw as Record<string, unknown>)
    const before = this.deps.settings.preferences()
    const changes: SettingChange[] = (Object.keys(patch) as BotSettingName[])
      .filter((field) => !sameValue(before[field], patch[field]))
      .map((field) => ({ field, from: before[field] ?? null, to: patch[field] ?? null }))
    if (changes.length === 0) return toolText('Nothing to change: every value is already set.')

    const direct = changes.filter((c) => !BOT_SETTING_FIELDS[c.field].confirm)
    const confirmed = changes.filter((c) => BOT_SETTING_FIELDS[c.field].confirm)
    const parts: string[] = []
    if (direct.length) {
      const after = this.deps.settings.update(
        Object.fromEntries(direct.map((c) => [c.field, c.to])) as Partial<WorkspacePreferences>,
      )
      parts.push(
        `Changed: ${direct.map((c) => this.describe(ctx.bot, { ...c, to: after[c.field] })).join('; ')}.`,
      )
    }
    if (confirmed.length) {
      const reason = optionalString(a, 'reason')?.trim().slice(0, 300) ?? ''
      parts.push(
        `Asked the user to confirm ${confirmed.map((c) => this.describe(ctx.bot, c)).join('; ')}: ` +
          (await this.deps.changes.propose(ctx, confirmed, reason)),
      )
    }
    return toolText(parts.join('\n'))
  }
}
