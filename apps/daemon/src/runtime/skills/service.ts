import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

import {
  parseSkillMd,
  procedureStepImage,
  renderSkillMd,
  type SkillContext,
  skillNameError,
  slugifySkillName,
} from '@milibot/agent'
import { formatProcedure, formatSkillCatalog } from '@milibot/agent/prompts'
import { TOOL_FAMILIES, TOOL_FAMILY_NAMES } from '@milibot/agent/tools'
import {
  type Bot,
  type BotScope,
  type BotSkill,
  type CreateSkillBody,
  estimateTokens,
  type LogFn,
  newId,
  type Procedure,
  type Skill,
  SKILL_LIMITS,
  type SkillDetail,
  type skillEndpoints,
  type SkillFile,
  type SkillOrigin,
  SKILLS_VM_ROOT,
  type SkillSource,
  type SkillUsage,
  type UpdateSkillBody,
  type WorkspaceEvent,
} from '@milibot/shared'
import type { z } from 'zod'

import { type Db, parseJson } from '../../db/sqlite'
import { DaemonError, notFound } from '../../errors'
import type { EndpointHandlers } from '../../handlers'
import type { ProcedureService } from '../procedures'
import { foldKey } from '../tools-core'
import type { VmController } from '../vm'
import type { WorkspaceStore } from '../workspace-store'
import { type NewSkillFile, skillFilesProblem, SkillFolders } from './folders'
import { type ImportTarget, type InstallInput, SkillImporter } from './import'
import { type ScannedSkill, SkillLibrary } from './library'
import { type SkillRow, SkillStore } from './store'
import { type MirroredSkill, SkillVmMirror } from './vm-sync'

/** A procedure's catalog line is only its goal: this says it is the way the user does it on the screen. */
const TAUGHT_CATALOG_PREFIX = 'Taught by the user on the screen: '

export interface SkillEntry {
  id: string
  slug: string
  source: SkillSource
  scanned: ScannedSkill | null
  procedure: Procedure | null
  row: SkillRow | null
  name: string
  description: string
  error: string | null
  tools: string[]
  defaultFor: 'all' | 'first'
  allowed: BotScope
  enabled: boolean
  /** Bots with an explicit switch on / off. */
  enabledFor: string[]
  disabledFor: string[]
}

interface BotState {
  enabled: boolean
  allowed: boolean
  active: boolean
}

const FOLDER_SOURCES: readonly SkillSource[] = ['user', 'import', 'bot']
const USAGE_DAYS = 30
const DAY_MS = 86_400_000

export function vmPathOf(slug: string): string {
  return `${SKILLS_VM_ROOT}/${slug}`
}

export interface SkillServiceDeps {
  db: Db
  store: WorkspaceStore
  /** `<wsDir>/skills`. */
  userDir: string
  builtinDir: string | null
  procedures: Pick<ProcedureService, 'list'>
  vm: VmController
  emit: (event: WorkspaceEvent) => void
  now: () => number
  /** Successful `skill_load` calls since a time, with their arguments (usage of a skill). */
  skillLoads: (since: number) => Array<{ botId: string | null; args: unknown }>
  /** GitHub REST API base (tests point it at a local server). */
  githubApi?: string
  /** The workspace's GitHub token, for private repositories. */
  githubToken?: () => Promise<string | null>
  fetch?: typeof fetch
  log?: LogFn
}

/**
 * The workspace's skills: built-ins, folders in `<wsDir>/skills` and taught procedures, with their switches
 * (workspace, access list, per bot), the catalog and tool families of each bot, the routes of the settings
 * screen and the mirror of skill files in the VM.
 */
export class SkillService {
  private readonly rows: SkillStore
  private readonly folders: SkillFolders
  private readonly library: SkillLibrary
  private readonly mirror: SkillVmMirror
  /** Also used by `SkillAdmin` for the bots' imports. */
  readonly importer: SkillImporter
  private known = new Map<string, string>()
  private initialized = false

  constructor(private readonly deps: SkillServiceDeps) {
    this.rows = new SkillStore(deps.db, deps.now)
    this.folders = new SkillFolders(deps.userDir)
    const log = deps.log ? { log: deps.log } : {}
    this.library = new SkillLibrary({
      userDir: deps.userDir,
      builtinDir: deps.builtinDir,
      onChange: () => this.refresh(),
      ...log,
    })
    this.mirror = new SkillVmMirror({ vm: deps.vm, desired: () => this.mirrored(), ...log })
    this.importer = new SkillImporter({
      importsDir: join(deps.userDir, '.imports'),
      workspaceDir: dirname(deps.userDir),
      targets: () => this.entries().map((e) => this.importTarget(e)),
      install: (input) => this.install(input),
      saveOrigin: (id, origin) => {
        this.rows.saveOrigin(id, JSON.stringify(origin))
        this.refresh()
      },
      githubApi: deps.githubApi ?? 'https://api.github.com',
      githubToken: deps.githubToken ?? (async () => null),
      fetch: deps.fetch ?? fetch,
      now: deps.now,
      ...log,
    })
  }

  start(): void {
    this.folders.prepare()
    this.importer.start()
    this.refresh()
    this.library.watch()
    this.mirror.start()
  }

  async stop(): Promise<void> {
    this.library.close()
    this.importer.stop()
    await this.mirror.stop()
  }

  /** Resolves when the VM mirror and the update checks have nothing running or scheduled (tests). */
  async idle(): Promise<void> {
    await this.importer.idle()
    await this.mirror.idle()
  }

  /** Reads the folders again and announces what changed since the last look. */
  refresh(): SkillEntry[] {
    this.library.markDirty()
    return this.entries(true)
  }

  entries(force = false): SkillEntry[] {
    const { builtins, user } = this.library.scan(force)
    const rows = this.rows.rows()
    const switches = this.switchesBySkill()
    const botSwitches = (id: string) => ({
      enabledFor: switches.get(id)?.on ?? [],
      disabledFor: switches.get(id)?.off ?? [],
    })
    const out: SkillEntry[] = []
    const builtinSlugs = new Set(builtins.map((b) => b.slug))
    for (const scanned of builtins) {
      const id = `builtin:${scanned.slug}`
      const row = rows.get(id) ?? null
      out.push({
        id,
        slug: scanned.slug,
        source: 'builtin',
        scanned,
        procedure: null,
        row,
        name: scanned.meta?.name ?? scanned.slug,
        description: scanned.meta?.description ?? '',
        error: scanned.error,
        tools: scanned.meta?.milibot?.tools ?? [],
        defaultFor: scanned.meta?.milibot?.default ?? 'all',
        allowed: row ? parseJson<BotScope>(row.allowed_bots, 'all') : 'all',
        enabled: row ? row.enabled === 1 : true,
        ...botSwitches(id),
      })
    }
    const folderRows = [...rows.values()].filter((r) => FOLDER_SOURCES.includes(r.source))
    const bySlug = new Map(folderRows.map((r) => [r.slug, r]))
    for (const scanned of user) {
      const row =
        bySlug.get(scanned.slug) ??
        this.rows.insert({ id: newId('skill'), slug: scanned.slug, source: 'user', allowed: 'all' })
      out.push({
        id: row.id,
        slug: scanned.slug,
        source: row.source,
        scanned,
        procedure: null,
        row,
        name: scanned.meta?.name ?? scanned.slug,
        description: scanned.meta?.description ?? '',
        error:
          scanned.error ??
          (builtinSlugs.has(scanned.slug)
            ? 'A skill included in Milibot already has this name; rename the folder and the name in SKILL.md.'
            : null),
        tools: [],
        defaultFor: 'all',
        allowed: parseJson<BotScope>(row.allowed_bots, 'all'),
        enabled: row.enabled === 1,
        ...botSwitches(row.id),
      })
    }
    const present = new Set(user.map((u) => u.slug))
    for (const row of folderRows) if (!present.has(row.slug)) this.rows.delete(row.id)

    const taken = new Set(out.map((e) => e.slug))
    const procedures = this.deps.procedures.list().filter((p) => p.status === 'ready')
    for (const procedure of procedures) {
      const base = slugifySkillName(procedure.name)
      let slug = base
      for (let n = 2; taken.has(slug); n++) slug = `${base.slice(0, SKILL_LIMITS.nameLength - 4)}-${n}`
      taken.add(slug)
      const row = rows.get(procedure.id) ?? null
      out.push({
        id: procedure.id,
        slug,
        source: 'taught',
        scanned: null,
        procedure,
        row,
        name: procedure.name,
        description: procedure.goal.trim() || procedure.name,
        error: null,
        tools: [],
        defaultFor: 'all',
        allowed: procedure.botId ? [procedure.botId] : 'all',
        enabled: row ? row.enabled === 1 : true,
        ...botSwitches(procedure.id),
      })
    }
    const taught = new Set(procedures.map((p) => p.id))
    for (const row of rows.values())
      if (row.source === 'taught' && !taught.has(row.id)) this.rows.delete(row.id)

    this.announce(out)
    return out
  }

  /** Emits `skill.updated`/`skill.deleted` for what changed since the previous look (none on the first). */
  private announce(entries: SkillEntry[]): void {
    const next = new Map<string, string>()
    let filesChanged = false
    for (const entry of entries) {
      const fingerprint = `${JSON.stringify(this.toSkill(entry))}|${entry.scanned?.hash ?? ''}`
      next.set(entry.id, fingerprint)
      const before = this.known.get(entry.id)
      if (before === fingerprint) continue
      if (entry.scanned && before?.split('|').at(-1) !== entry.scanned.hash) filesChanged = true
      if (this.initialized) this.deps.emit({ type: 'skill.updated', payload: { skill: this.toSkill(entry) } })
    }
    for (const id of this.known.keys()) {
      if (next.has(id)) continue
      filesChanged = true
      if (this.initialized) this.deps.emit({ type: 'skill.deleted', payload: { skillId: id } })
    }
    this.known = next
    if (filesChanged && this.initialized) this.mirror.schedule()
    this.initialized = true
  }

  /** Explicit per-bot switches of every skill, active bots only, in the bots' order. */
  private switchesBySkill(): Map<string, { on: string[]; off: string[] }> {
    const order = new Map(this.deps.store.bots.list().map((b, i) => [b.id, i]))
    const prefs = this.rows
      .allPrefs()
      .filter((p) => order.has(p.botId))
      .sort((a, b) => (order.get(a.botId) as number) - (order.get(b.botId) as number))
    const out = new Map<string, { on: string[]; off: string[] }>()
    for (const pref of prefs) {
      const entry = out.get(pref.skillId) ?? { on: [], off: [] }
      ;(pref.enabled ? entry.on : entry.off).push(pref.botId)
      out.set(pref.skillId, entry)
    }
    return out
  }

  private origin(entry: SkillEntry): SkillOrigin | null {
    return entry.row?.source_json ? parseJson<SkillOrigin | null>(entry.row.source_json, null) : null
  }

  private importTarget(entry: SkillEntry): ImportTarget {
    return { id: entry.id, slug: entry.slug, source: entry.source, origin: this.origin(entry) }
  }

  private toSkill(entry: SkillEntry): Skill {
    const { scanned, procedure } = entry
    const origin = this.origin(entry)
    return {
      id: entry.id,
      slug: entry.slug,
      name: entry.name,
      description: entry.description,
      source: entry.source,
      origin: origin as Record<string, unknown> | null,
      authorBotId: entry.row?.author_bot_id ?? null,
      enabled: entry.enabled,
      allowedBots: entry.allowed,
      defaultFor: entry.defaultFor,
      tools: entry.tools,
      toolCount: entry.tools.reduce(
        (sum, family) => sum + (TOOL_FAMILIES[family as keyof typeof TOOL_FAMILIES]?.length ?? 0),
        0,
      ),
      enabledFor: entry.enabledFor,
      disabledFor: entry.disabledFor,
      updateAvailable: entry.source === 'import' && !!origin?.latestSha,
      error: entry.error,
      editable: FOLDER_SOURCES.includes(entry.source),
      tokens: scanned ? scanned.tokens : procedure ? estimateTokens(formatProcedure(procedure)) : 0,
      fileCount: scanned
        ? scanned.files.length
        : (procedure?.steps.filter((s) => s.screenshotSha).length ?? 0),
      bytes: scanned?.bytes ?? 0,
      hasScripts: scanned?.hasScripts ?? false,
      createdAt: entry.row?.created_at ?? procedure?.createdAt ?? 0,
      updatedAt: entry.row?.updated_at ?? procedure?.updatedAt ?? 0,
    }
  }

  files(entry: SkillEntry): SkillFile[] {
    if (entry.scanned) return entry.scanned.files
    return (entry.procedure?.steps ?? [])
      .filter((s) => s.screenshotSha)
      .map((s) => ({ path: procedureStepImage(s.position), bytes: 0, executable: false }))
  }

  private hasMirror(entry: SkillEntry): boolean {
    return !!entry.scanned && !entry.error && entry.scanned.files.some((f) => f.path !== 'SKILL.md')
  }

  private detail(entry: SkillEntry): SkillDetail {
    return {
      ...this.toSkill(entry),
      skillMd: entry.scanned?.skillMd ?? null,
      files: this.files(entry),
      vmPath: this.hasMirror(entry) ? vmPathOf(entry.slug) : null,
      folderPath: entry.scanned?.dir ?? null,
    }
  }

  private mirrored(): MirroredSkill[] {
    return this.entries()
      .filter((e) => this.hasMirror(e))
      .map((e) => {
        const scanned = e.scanned as ScannedSkill
        return {
          slug: e.slug,
          dir: scanned.dir,
          hash: scanned.hash,
          files: scanned.files.map((f) => ({ path: f.path, executable: f.executable })),
          bytes: scanned.bytes,
        }
      })
  }

  private entry(id: string): SkillEntry {
    const entry = this.entries().find((e) => e.id === id)
    if (!entry) throw notFound('skill', id)
    return entry
  }

  private ensureRow(entry: SkillEntry): SkillRow {
    if (entry.row) return entry.row
    const slug = entry.source === 'builtin' ? `builtin:${entry.slug}` : `taught:${entry.id}`
    return this.rows.ensure({ id: entry.id, slug, source: entry.source })
  }

  private botState(entry: SkillEntry, bot: Bot, prefs: Map<string, boolean>): BotState {
    const enabled = prefs.get(entry.id) ?? entry.defaultFor !== 'first'
    const allowed = entry.allowed === 'all' || entry.allowed.includes(bot.id)
    return { enabled, allowed, active: !entry.error && entry.enabled && allowed && enabled }
  }

  /** Whether each skill is active for `bot` (its switches read once). */
  activeFor(bot: Bot): (entry: SkillEntry) => boolean {
    const prefs = this.rows.prefs(bot.id)
    return (entry) => this.botState(entry, bot, prefs).active
  }

  /** The bot's catalog and tool families: a built-in's families go away only while it is off for the bot. */
  skillContext(bot: Bot): SkillContext {
    const entries = this.entries()
    const prefs = this.rows.prefs(bot.id)
    const on = new Set<string>()
    const off = new Set<string>()
    const active: SkillEntry[] = []
    for (const entry of entries) {
      const state = this.botState(entry, bot, prefs)
      if (state.active) active.push(entry)
      if (entry.source === 'builtin') for (const family of entry.tools) (state.active ? on : off).add(family)
    }
    return {
      catalog: formatSkillCatalog(
        active.map((e) => ({
          name: e.slug,
          description: e.source === 'taught' ? `${TAUGHT_CATALOG_PREFIX}${e.description}` : e.description,
        })),
      ),
      families: new Set(TOOL_FAMILY_NAMES.filter((f) => on.has(f) || !off.has(f))),
    }
  }

  private botSkill(entry: SkillEntry, bot: Bot, prefs = this.rows.prefs(bot.id)): BotSkill {
    return { skill: this.toSkill(entry), ...this.botState(entry, bot, prefs) }
  }

  slugTaken(slug: string, except?: string): SkillEntry | null {
    return this.entries().find((e) => e.slug === slug && e.id !== except) ?? null
  }

  /**
   * Writes a skill a bot saved: a new `bot` row, or its own skill of that name again (`existing`), which
   * keeps its access list unless `scope` is given.
   */
  saveFromBot(input: {
    bot: Bot
    name: string
    files: Map<string, NewSkillFile>
    scope: 'all' | 'me' | null
    existing: SkillEntry | null
  }): SkillEntry | null {
    const { bot, name, scope, existing } = input
    const allowed: BotScope = scope === 'all' ? 'all' : [bot.id]
    this.folders.write(name, input.files)
    if (existing?.row)
      this.rows.markBotOwned(
        existing.row.id,
        bot.id,
        scope ? JSON.stringify(allowed) : existing.row.allowed_bots,
      )
    else this.rows.insert({ id: newId('skill'), slug: name, source: 'bot', allowed, authorBotId: bot.id })
    return this.refresh().find((e) => e.slug === name) ?? null
  }

  /**
   * Deletes a folder skill with its row. The user deletes any skill but the built-ins and taught procedures
   * (turned off, or deleted as procedures); a bot only the skills it created.
   */
  remove(id: string, by: 'user' | { bot: Bot }): void {
    const entry = this.entry(id)
    if (by === 'user') {
      if (entry.source === 'builtin')
        throw new DaemonError('conflict', 'Skills included in Milibot cannot be deleted; turn them off', {
          reason: 'builtin',
        })
      if (entry.source === 'taught')
        throw new DaemonError('conflict', 'Delete taught procedures as procedures', { reason: 'taught' })
    } else if (entry.source !== 'bot' || entry.row?.author_bot_id !== by.bot.id) {
      throw new DaemonError(
        'conflict',
        `You can only delete the skills you created; "${entry.slug}" is not one of them.`,
        { reason: 'not_own' },
      )
    }
    this.folders.remove(entry.slug)
    this.rows.delete(entry.id)
    this.refresh()
  }

  private create(body: z.output<typeof CreateSkillBody>): SkillDetail {
    const nameError = skillNameError(body.name)
    if (nameError) throw new DaemonError('validation_failed', nameError, { reason: 'invalid_name' })
    if (this.slugTaken(body.name))
      throw new DaemonError('conflict', `A skill named "${body.name}" already exists`, {
        reason: 'name_taken',
      })
    const skillMd = renderSkillMd({ name: body.name, description: body.description }, body.body)
    const parsed = parseSkillMd(skillMd)
    if (!parsed.ok) throw new DaemonError('validation_failed', parsed.error, { reason: 'invalid_skill_md' })
    const id = newId('skill')
    this.folders.write(
      body.name,
      new Map([['SKILL.md', { data: Buffer.from(skillMd, 'utf8'), executable: false }]]),
    )
    this.rows.insert({ id, slug: body.name, source: 'user', allowed: body.allowedBots ?? 'all' })
    this.refresh()
    return this.detail(this.entry(id))
  }

  private putContent(id: string, skillMd: string): SkillDetail {
    const entry = this.entry(id)
    if (!FOLDER_SOURCES.includes(entry.source) || !entry.scanned)
      throw new DaemonError('conflict', 'This skill cannot be edited', { reason: 'not_editable' })
    const parsed = parseSkillMd(skillMd)
    if (!parsed.ok) throw new DaemonError('validation_failed', parsed.error, { reason: 'invalid_skill_md' })
    if (parsed.meta.name !== entry.slug)
      throw new DaemonError('validation_failed', `The name must stay "${entry.slug}"`, {
        reason: 'name_changed',
      })
    this.folders.writeSkillMd(entry.scanned.dir, skillMd)
    this.rows.touch(id)
    this.refresh()
    return this.detail(this.entry(id))
  }

  private duplicate(id: string): SkillDetail {
    const entry = this.entry(id)
    const scanned = entry.scanned
    if (!scanned)
      throw new DaemonError('conflict', 'Taught procedures cannot be duplicated', { reason: 'taught' })
    if (!scanned.meta)
      throw new DaemonError('conflict', 'Fix the SKILL.md first', { reason: 'invalid_skill_md' })
    const base = `${entry.slug.slice(0, SKILL_LIMITS.nameLength - 5)}-copy`
    let slug = base
    for (let n = 2; this.slugTaken(slug); n++) slug = `${base.slice(0, SKILL_LIMITS.nameLength - 4)}-${n}`
    const { name: _name, milibot: _milibot, ...meta } = scanned.meta
    this.folders.copy(scanned.dir, slug, renderSkillMd({ ...meta, name: slug }, scanned.body))
    const newSkillId = newId('skill')
    this.rows.insert({ id: newSkillId, slug, source: 'user', allowed: entry.allowed })
    this.refresh()
    return this.detail(this.entry(newSkillId))
  }

  private update(id: string, body: z.output<typeof UpdateSkillBody>): Skill {
    const entry = this.entry(id)
    if (body.allowedBots !== undefined && entry.source === 'taught')
      throw new DaemonError('conflict', "A taught procedure's access follows its scope", { reason: 'taught' })
    const row = this.ensureRow(entry)
    this.rows.setSwitch(
      row.id,
      body.enabled === undefined ? row.enabled : body.enabled ? 1 : 0,
      body.allowedBots === undefined ? row.allowed_bots : JSON.stringify(body.allowedBots),
    )
    this.refresh()
    return this.toSkill(this.entry(id))
  }

  /** Every skill with its state for the bot. */
  botSkills(bot: Bot): BotSkill[] {
    const prefs = this.rows.prefs(bot.id)
    return this.entries().map((e) => this.botSkill(e, bot, prefs))
  }

  /** Adds a bot to a skill's access list (no change when it already has access). */
  allowBot(skillId: string, botId: string): void {
    const entry = this.entry(skillId)
    if (entry.allowed === 'all' || entry.allowed.includes(botId)) return
    this.update(skillId, { allowedBots: [...entry.allowed, botId] })
  }

  /** A bot's own switch of a skill (the bot settings screen, an approved `bot_skills_set`). */
  setBotSkill(botId: string, skillId: string, enabled: boolean): BotSkill {
    const bot = this.deps.store.bots.get(botId)
    this.ensureRow(this.entry(skillId))
    this.rows.setPref({ botId: bot.id, skillId, enabled })
    const current = this.refresh().find((e) => e.id === skillId) as SkillEntry
    this.deps.emit({ type: 'skill.updated', payload: { skill: this.toSkill(current) } })
    return this.botSkill(current, bot)
  }

  /** Writes an imported skill's folder and its row (a new one, or the one it replaces). */
  private install(input: InstallInput): Skill {
    const problem = skillFilesProblem(input.files)
    if (problem) throw new DaemonError('validation_failed', problem, { reason: 'invalid_skill' })
    const originJson = JSON.stringify(input.origin)
    if (input.replaceId) {
      const entry = this.entry(input.replaceId)
      if (!FOLDER_SOURCES.includes(entry.source) || !entry.row || entry.slug !== input.slug)
        throw new DaemonError('conflict', 'This skill cannot be replaced', { reason: 'not_editable' })
      this.folders.write(input.slug, input.files)
      this.rows.markImported(
        entry.id,
        originJson,
        input.allowedBots === null ? entry.row.allowed_bots : JSON.stringify(input.allowedBots),
      )
      this.refresh()
      return this.toSkill(this.entry(entry.id))
    }
    if (skillNameError(input.slug) || this.slugTaken(input.slug))
      throw new DaemonError('conflict', `A skill named "${input.slug}" already exists`, {
        reason: 'name_taken',
      })
    const id = newId('skill')
    this.folders.write(input.slug, input.files)
    this.rows.insert({
      id,
      slug: input.slug,
      source: 'import',
      allowed: input.allowedBots ?? 'all',
      originJson,
    })
    this.refresh()
    return this.toSkill(this.entry(id))
  }

  private async updateSource(id: string, apply: boolean) {
    const result = await this.importer.updateFromSource(this.importTarget(this.entry(id)), apply)
    return { ...result, skill: this.detail(this.entry(id)) }
  }

  private usage(id: string): SkillUsage {
    const entry = this.entry(id)
    const names = new Set([foldKey(entry.slug), foldKey(entry.name), entry.id])
    const counts = new Map<string, number>()
    let loads = 0
    for (const call of this.deps.skillLoads(this.deps.now() - USAGE_DAYS * DAY_MS)) {
      const name = (call.args as { name?: unknown } | null)?.name
      const text = typeof name === 'string' ? name : ''
      if (!names.has(foldKey(text)) && !names.has(text.trim())) continue
      loads++
      if (call.botId) counts.set(call.botId, (counts.get(call.botId) ?? 0) + 1)
    }
    return {
      days: USAGE_DAYS,
      loads,
      bots: [...counts].map(([botId, count]) => ({ botId, count })).sort((a, b) => b.count - a.count),
    }
  }

  handlers(): EndpointHandlers<keyof typeof skillEndpoints> {
    return {
      listSkills: () => {
        const entries = this.entries()
        this.importer.scheduleChecks(entries.map((e) => this.importTarget(e)))
        return entries.map((e) => this.toSkill(e))
      },
      createSkill: ({ body }) => this.create(body),
      getSkill: ({ params }) => this.detail(this.entry(params.skillId)),
      updateSkill: ({ params, body }) => this.update(params.skillId, body),
      putSkillContent: ({ params, body }) => this.putContent(params.skillId, body.skillMd),
      deleteSkill: ({ params }) => {
        this.remove(params.skillId, 'user')
        return { ok: true as const }
      },
      duplicateSkill: ({ params }) => this.duplicate(params.skillId),
      listBotSkills: ({ params }) => this.botSkills(this.deps.store.bots.get(params.botId)),
      updateBotSkill: ({ params, body }) => this.setBotSkill(params.botId, params.skillId, body.enabled),
      scanSkillImport: ({ body }) => this.importer.scan(body.source),
      commitSkillImport: ({ body }) => this.importer.commit(body),
      updateSkillSource: ({ params, body }) => this.updateSource(params.skillId, body.apply),
      getSkillUsage: ({ params }) => this.usage(params.skillId),
      getSkillsFolder: () => {
        mkdirSync(this.deps.userDir, { recursive: true })
        return { path: this.deps.userDir, vmPath: SKILLS_VM_ROOT }
      },
    }
  }
}
