import { type AgentHost, parseSkillMd, type ToolExecContext } from '@milibot/agent'
import { TOOL_FAMILIES, ToolInputError } from '@milibot/agent/tools'
import type { Bot, BotScope, ConfirmationPayload, LogFn, Message, SkillImportScan } from '@milibot/shared'

import { DaemonError, errorMessage } from '../../errors'
import {
  type ConfirmationAction,
  type ConfirmationHandler,
  type ConfirmationParams,
  ConfirmationWaits,
} from '../groups'
import { foldKey } from '../tools-core'
import type { BotImportSource, ScanPin } from './import'
import type { SkillEntry, SkillService } from './service'

/** What the confirmation stores for its handler. */
export type SkillProposal =
  | {
      kind: 'import'
      pin: ScanPin
      scanId: string
      /** Candidate key → hash of what the user was shown (`SkillImporter.digests`). */
      digests: Record<string, string>
      allowedBots: BotScope
    }
  | { kind: 'bot_skills'; botId: string; changes: Array<{ skillId: string; on: boolean; allow: boolean }> }

/** The `skill_import` card's `details` param (JSON). */
export interface SkillImportCardDetails {
  source: { kind: 'github'; repo: string; ref: string; sha: string } | { kind: 'zip'; path: string }
  skills: Array<{
    name: string
    importAs: string
    description: string
    files: number
    bytes: number
    conflict: SkillImportScan['candidates'][number]['conflict']
    hasScripts: boolean
    /** Families its SKILL.md asks for: ignored, an imported skill never unlocks tools. */
    declaredTools: string[]
  }>
  /** Bot names, or 'all'. */
  bots: string[] | 'all'
  /** Tool families the import unlocks: always none. */
  families: string[]
}

/** The `bot_skills` card's `details` param (JSON). */
export interface BotSkillsCardDetails {
  changes: Array<{
    skill: string
    on: boolean
    /** Tool families the skill unlocks for the bot, and how many tools they hold. */
    families: string[]
    tools: number
    /** The bot is not on the skill's access list: approving also gives it access. */
    allow: boolean
  }>
}

const ACTIONS = { import: 'skill_import', bot_skills: 'bot_skills' } as const satisfies Record<
  SkillProposal['kind'],
  ConfirmationAction
>

export interface SkillAdminDeps {
  skills: Pick<SkillService, 'importer' | 'entries' | 'botSkills' | 'setBotSkill' | 'allowBot'>
  confirmations: {
    request(input: {
      bot: Bot
      conversationId: string | null
      action: ConfirmationAction
      params: ConfirmationParams
      reason: string
      data: Record<string, unknown>
    }): Message
    onConfirmed(action: ConfirmationAction, handler: ConfirmationHandler): void
    onRejected(action: ConfirmationAction, handler: ConfirmationHandler): void
    /** Marks an approved card expired (what was approved can no longer be applied). */
    expire(confirmationId: string): void
  }
  host: Pick<AgentHost, 'enqueueTurn'>
  findBot: (id: string) => Bot | null
  listBots: () => Bot[]
  managesTeam: (bot: Bot) => boolean
  /** The current bytes of a zip in the VM. */
  readVmZip: (path: string) => Promise<Buffer>
  timeoutSeconds: () => number
  log: LogFn
}

const NOT_MANAGER = 'Only a bot that manages the team (team-management skill on) can do this.'

const familiesOf = (entry: SkillEntry): string[] => (entry.source === 'builtin' ? entry.tools : [])
const toolCount = (families: string[]): number =>
  families.reduce((sum, f) => sum + (TOOL_FAMILIES[f as keyof typeof TOOL_FAMILIES]?.length ?? 0), 0)

/**
 * Skills changed by a bot that manages the team: imports into the library and a bot's own switches. Every
 * change waits for the user's confirmation card, then goes through `SkillService` (the settings screen's
 * path). An import installs only what still hashes the same as what the card showed.
 */
export class SkillAdmin {
  private readonly waits: ConfirmationWaits

  constructor(private readonly deps: SkillAdminDeps) {
    this.waits = new ConfirmationWaits(deps)
    for (const kind of ['import', 'bot_skills'] as const) {
      deps.confirmations.onConfirmed(ACTIONS[kind], (input) => this.approved(input))
      deps.confirmations.onRejected(ACTIONS[kind], (input) => this.rejected(input))
    }
  }

  stop(): void {
    this.waits.clear()
  }

  assertManager(bot: Bot): void {
    if (!this.deps.managesTeam(bot)) throw new ToolInputError(NOT_MANAGER)
  }

  /** Scans the source and asks the user to approve importing the chosen skills. */
  async proposeImport(
    ctx: ToolExecContext,
    input: { source: BotImportSource; names: string[]; allowedBots: BotScope; reason: string },
  ): Promise<string> {
    this.assertManager(ctx.bot)
    const { importer } = this.deps.skills
    const { scan, pin } = await importer.scanForBot(input.source)
    let keys: string[]
    try {
      keys = this.chosen(scan, input.names)
    } catch (err) {
      importer.discard(scan.scanId)
      throw err
    }
    const all = await importer.digests(scan.scanId)
    const digests = Object.fromEntries(keys.map((k) => [k, all[k] as string]))
    const skillMds = importer.skillMds(scan.scanId)
    const details: SkillImportCardDetails = {
      source:
        pin.kind === 'github'
          ? { kind: 'github', repo: pin.repo, ref: pin.ref, sha: pin.sha }
          : { kind: 'zip', path: pin.vmPath },
      skills: scan.candidates
        .filter((c) => keys.includes(c.path))
        .map((c) => ({
          name: c.name,
          importAs: c.importAs,
          description: c.description,
          files: c.files,
          bytes: c.bytes,
          conflict: c.conflict,
          hasScripts: c.hasScripts,
          declaredTools: this.declaredTools(skillMds[c.path] ?? null),
        })),
      bots: this.botNames(input.allowedBots),
      families: [],
    }
    const proposal: SkillProposal = {
      kind: 'import',
      pin,
      scanId: scan.scanId,
      digests,
      allowedBots: input.allowedBots,
    }
    const source = pin.kind === 'github' ? `${pin.repo}@${pin.sha.slice(0, 7)}` : pin.vmPath
    return this.propose(
      ctx,
      proposal,
      { botId: ctx.bot.id, botName: ctx.bot.name, source },
      details,
      input.reason,
    )
  }

  /** Asks the user to approve turning skills on or off for a bot. */
  proposeBotSkills(
    ctx: ToolExecContext,
    input: { bot: Bot; enable: string[]; disable: string[]; reason: string },
  ): Promise<string> | string {
    this.assertManager(ctx.bot)
    const states = this.deps.skills.botSkills(input.bot)
    const entries = this.deps.skills.entries()
    const changes: Array<{ entry: SkillEntry; on: boolean; allow: boolean }> = []
    const already: string[] = []
    const both = input.enable.filter((ref) => input.disable.some((d) => foldKey(d) === foldKey(ref)))
    if (both.length) throw new ToolInputError(`${both.join(', ')}: both in "enable" and "disable"`)
    for (const [refs, on] of [
      [input.enable, true],
      [input.disable, false],
    ] as const) {
      for (const ref of refs) {
        const entry = this.findSkill(entries, ref)
        const state = states.find((s) => s.skill.id === entry.id)
        if (on) {
          if (entry.error) throw new ToolInputError(`The skill "${entry.slug}" is invalid: ${entry.error}`)
          if (!entry.enabled)
            throw new ToolInputError(
              `The skill "${entry.slug}" is turned off for the whole workspace: only the user turns it on, in ` +
                'Settings > Skills.',
            )
          if (entry.source === 'taught' && !state?.allowed)
            throw new ToolInputError(
              `The taught procedure "${entry.slug}" is not shared with ${input.bot.name}.`,
            )
        }
        if (state && state.enabled === on && (!on || state.allowed)) {
          already.push(entry.slug)
          continue
        }
        if (changes.some((c) => c.entry.id === entry.id)) continue
        changes.push({ entry, on, allow: on && !state?.allowed })
      }
    }
    if (changes.length === 0) {
      if (already.length)
        return `Nothing to change: ${already.join(', ')} already as asked for ${input.bot.name}.`
      throw new ToolInputError('Give the skills to turn on ("enable") or off ("disable").')
    }
    const details: BotSkillsCardDetails = {
      changes: changes.map(({ entry, on, allow }) => {
        const families = familiesOf(entry)
        return { skill: entry.slug, on, families, tools: toolCount(families), allow }
      }),
    }
    const proposal: SkillProposal = {
      kind: 'bot_skills',
      botId: input.bot.id,
      changes: changes.map((c) => ({ skillId: c.entry.id, on: c.on, allow: c.allow })),
    }
    return this.propose(
      ctx,
      proposal,
      { botId: input.bot.id, botName: input.bot.name },
      details,
      input.reason,
    )
  }

  private async propose(
    ctx: ToolExecContext,
    proposal: SkillProposal,
    params: ConfirmationParams,
    details: SkillImportCardDetails | BotSkillsCardDetails,
    reason: string,
  ): Promise<string> {
    const message = this.deps.confirmations.request({
      bot: ctx.bot,
      conversationId: ctx.conversationId,
      action: ACTIONS[proposal.kind],
      params: { ...params, details: JSON.stringify(details) },
      reason,
      data: { proposal },
    })
    const { confirmationId } = message.payload as ConfirmationPayload
    return this.waits.wait(ctx, confirmationId)
  }

  /** Candidate keys to import: the ones named (by name, new name or folder), else every valid one. */
  private chosen(scan: SkillImportScan, names: string[]): string[] {
    const valid = scan.candidates.filter((c) => !c.error)
    const listed = () =>
      scan.candidates.map((c) => (c.error ? `${c.name} (invalid: ${c.error})` : c.name)).join(', ')
    if (names.length === 0) {
      if (valid.length === 0) throw new ToolInputError(`No valid skill there: ${listed()}`)
      return valid.map((c) => c.path)
    }
    const keys: string[] = []
    for (const name of names) {
      const wanted = foldKey(name)
      const match = scan.candidates.find(
        (c) =>
          foldKey(c.name) === wanted ||
          foldKey(c.importAs) === wanted ||
          foldKey(c.path.split(/[#/]/).at(-1) ?? '') === wanted,
      )
      if (!match) throw new ToolInputError(`No skill "${name}" there. Found: ${listed()}`)
      if (match.error) throw new ToolInputError(`The skill "${match.name}" is invalid: ${match.error}`)
      if (!keys.includes(match.path)) keys.push(match.path)
    }
    return keys
  }

  private declaredTools(skillMd: string | null): string[] {
    if (!skillMd) return []
    const parsed = parseSkillMd(skillMd)
    return parsed.ok ? (parsed.meta.milibot?.tools ?? []) : []
  }

  private findSkill(entries: SkillEntry[], ref: string): SkillEntry {
    const wanted = foldKey(ref)
    const entry =
      entries.find((e) => e.slug === ref.trim() || e.id === ref.trim()) ??
      entries.find((e) => foldKey(e.slug) === wanted || foldKey(e.name) === wanted) ??
      null
    if (!entry) throw new ToolInputError(`No skill named "${ref}".`)
    return entry
  }

  private botNames(scope: BotScope): string[] | 'all' {
    if (scope === 'all') return 'all'
    const bots = this.deps.listBots()
    return scope.map((id) => bots.find((b) => b.id === id)?.name ?? id)
  }

  private listNames(ids: string[]): string {
    const names = this.botNames(ids)
    return names === 'all' ? 'every bot' : names.join(', ')
  }

  private proposalOf(data: Record<string, unknown>): SkillProposal | null {
    const proposal = data.proposal as SkillProposal | undefined
    return proposal && typeof proposal === 'object' && 'kind' in proposal ? proposal : null
  }

  private rejected(input: Parameters<ConfirmationHandler>[0]): void {
    const proposal = this.proposalOf(input.data)
    if (!proposal) return
    if (proposal.kind === 'import') this.deps.skills.importer.discard(proposal.scanId)
    const text =
      proposal.kind === 'import'
        ? `The user declined importing skills from ${input.params.source ?? 'that source'}. Nothing was installed.`
        : `The user declined changing the skills of ${input.params.botName}. Nothing changed.`
    this.waits.settle(input.confirmationId, input.requesterId, input.conversationId, text)
  }

  /** Runs on the user's approval; a DaemonError thrown here marks the card expired. */
  private approved(input: Parameters<ConfirmationHandler>[0]): void {
    const proposal = this.proposalOf(input.data)
    const bot = this.deps.findBot(input.requesterId)
    if (!proposal || !bot) throw new DaemonError('conflict', 'The bot that asked is gone')
    const settle = (text: string) =>
      this.waits.settle(input.confirmationId, bot.id, input.conversationId, text)
    if (!this.deps.managesTeam(bot)) {
      settle(`Not applied: you no longer manage the team. ${NOT_MANAGER}`)
      throw new DaemonError('conflict', NOT_MANAGER)
    }
    if (proposal.kind === 'bot_skills') {
      try {
        settle(this.applyBotSkills(proposal))
      } catch (err) {
        settle(`Not applied: ${errorMessage(err)}. Nothing changed.`)
        throw err
      }
      return
    }
    void this.applyImport(proposal)
      .catch((err: unknown) => {
        this.deps.log('warn', 'skill import failed', { err: errorMessage(err) })
        return { text: `The import did not work: ${errorMessage(err)}`, expired: false }
      })
      .then(({ text, expired }) => {
        if (expired) this.deps.confirmations.expire(input.confirmationId)
        settle(text)
      })
  }

  private applyBotSkills(proposal: Extract<SkillProposal, { kind: 'bot_skills' }>): string {
    const target = this.deps.findBot(proposal.botId)
    if (!target) throw new DaemonError('not_found', 'The bot is gone')
    const ids = new Set(this.deps.skills.entries().map((e) => e.id))
    const live = proposal.changes.filter((c) => ids.has(c.skillId))
    if (live.length === 0) throw new DaemonError('not_found', 'The skills are gone')
    const done: string[] = []
    for (const change of live) {
      if (change.allow) this.deps.skills.allowBot(change.skillId, target.id)
      const state = this.deps.skills.setBotSkill(target.id, change.skillId, change.on)
      done.push(
        `${state.skill.slug} ${change.on ? 'on' : 'off'}${change.on && !state.active ? ' (not active: check its workspace switch)' : ''}`,
      )
    }
    const gone = proposal.changes.length - live.length
    return (
      `The user approved. Skills of ${target.name}: ${done.join(', ')}` +
      `${gone ? ` (${gone} no longer exist)` : ''}. It takes effect from ${target.name}'s next turn.`
    )
  }

  private async applyImport(
    proposal: Extract<SkillProposal, { kind: 'import' }>,
  ): Promise<{ text: string; expired: boolean }> {
    const { importer } = this.deps.skills
    const changed = {
      text: 'The source changed since the user saw the card, so nothing was installed. Scan it again with skill_import.',
      expired: true,
    }
    let scanId = proposal.scanId
    if (!importer.isOpen(scanId)) {
      const zip =
        proposal.pin.kind === 'vm_zip'
          ? await this.deps.readVmZip(proposal.pin.vmPath).catch(() => null)
          : undefined
      if (zip === null) return changed
      const scan = await importer.scanPinned(proposal.pin, zip)
      if (!scan) return changed
      scanId = scan.scanId
    }
    try {
      const now = await importer.digests(scanId)
      const keys = Object.keys(proposal.digests)
      if (keys.some((key) => now[key] !== proposal.digests[key])) return changed
      const bots = new Set(this.deps.listBots().map((b) => b.id))
      const allowedBots: BotScope =
        proposal.allowedBots === 'all' ? 'all' : proposal.allowedBots.filter((id) => bots.has(id))
      const result = await importer.commit({ scanId, paths: keys, allowedBots })
      const forWhom = allowedBots === 'all' ? 'every bot' : this.listNames(allowedBots) || 'no bot'
      const lines = [
        result.imported.length
          ? `Imported ${result.imported.map((s) => s.slug).join(', ')} for ${forWhom}; they unlock no tool ` +
            'families. They are in the catalogs from the next turn.'
          : 'Nothing was imported.',
        ...result.failed.map((f) => `Failed: ${f.path}: ${f.error}`),
      ]
      return { text: lines.join('\n'), expired: false }
    } finally {
      importer.discard(scanId)
    }
  }
}
