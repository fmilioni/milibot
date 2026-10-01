import { readFileSync } from 'node:fs'
import { join, posix } from 'node:path'

import {
  type NewAgentMessage,
  parseSkillMd,
  pngSize,
  renderBuiltinBody,
  renderSkillMd,
  safeSkillPath,
  skillNameError,
  type ToolExecContext,
  type ToolResult,
} from '@milibot/agent'
import type { ContentPart } from '@milibot/agent/llm'
import { formatProcedure } from '@milibot/agent/prompts'
import { rawTextArg, textArg, type ToolArgs, toolError, ToolInputError } from '@milibot/agent/tools'
import { type Bot, type CliEngine, type Message, SKILL_LIMITS } from '@milibot/shared'

import type { FileBlobStore } from '../blobs'
import { imageMediaType, isThumbnailable, jpegSize } from '../files'
import type { ProcedureService } from '../procedures'
import { foldKey, type ToolHandlers, ToolSwitch } from '../tools-core'
import type { VmController } from '../vm'
import type { WorkspaceStore } from '../workspace-store'
import { type NewSkillFile, skillFilesProblem } from './folders'
import type { ScannedSkill } from './library'
import { LIST_FOLDER_SCRIPT } from './scripts/list-folder.generated'
import { type SkillEntry, type SkillService, vmPathOf } from './service'

const MAX_TEXT_CHARS = 60_000
const MAX_LOAD_SCREENSHOTS = 4
const MAX_LISTED_FILES = 100
const MAX_IMAGE_SIDE = 8000
const TAUGHT_STEP = /^step-(\d+)\.png$/

function sizeText(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

export interface SkillToolsDeps {
  skills: Pick<SkillService, 'entries' | 'activeFor' | 'files' | 'slugTaken' | 'saveFromBot' | 'remove'>
  store: WorkspaceStore
  vm: VmController
  blobs: FileBlobStore
  procedures: Pick<ProcedureService, 'markedImage'>
  /** The CLI engine the lane (default: the bot's own model) runs in; null = the native loop. */
  engine: (bot: Bot, laneKey?: string) => CliEngine | null
  /** Workspace settings a built-in skill's instructions end with (e.g. the pull request preference). */
  notes?: (slug: string) => string | null
  /** Posts the `skill_created` card of `skill_save`. */
  appendMessage?: (message: NewAgentMessage) => Message
}

/** The bots' skill tools: load and read a skill of their catalog, save and delete their own. */
export class SkillTools extends ToolSwitch {
  readonly name = 'skills'
  protected readonly handlers: ToolHandlers = {
    skill_load: (c, a) => this.load(c.bot, skillName(a), c.laneKey),
    skill_read: (c, a) => this.read(c.bot, skillName(a), rawTextArg(a, 'path')),
    skill_save: (c, a) => this.save(c, skillName(a), a),
    skill_delete: (c, a) => this.delete(c.bot, skillName(a)),
  }

  constructor(private readonly deps: SkillToolsDeps) {
    super()
  }

  /** A skill of the bot's catalog by name (its slug, or a taught procedure's own name). */
  private findForBot(bot: Bot, ref: string): { entry: SkillEntry } | { problem: string } {
    const entries = this.deps.skills.entries()
    const active = this.deps.skills.activeFor(bot)
    const wanted = foldKey(ref)
    const entry =
      entries.find((e) => e.slug === ref.trim()) ??
      entries.find((e) => foldKey(e.slug) === wanted || foldKey(e.name) === wanted || e.id === ref.trim()) ??
      null
    if (!entry || entry.error) {
      const names = entries.filter(active).map((e) => e.slug)
      return {
        problem: `No skill named "${ref}".${names.length ? ` Your skills: ${names.join(', ')}.` : ''}`,
      }
    }
    if (!active(entry))
      return {
        problem: `The skill "${entry.slug}" is not available to you (turned off or not shared with you).`,
      }
    return { entry }
  }

  private async load(bot: Bot, ref: string, laneKey?: string): Promise<ToolResult> {
    const found = this.findForBot(bot, ref)
    if ('problem' in found) return toolError(found.problem)
    const { entry } = found
    if (entry.procedure) {
      const procedure = entry.procedure
      const content: ContentPart[] = [{ type: 'text', text: formatProcedure(procedure) }]
      const shots = procedure.steps.filter((s) => s.screenshotSha)
      const picked =
        shots.length <= MAX_LOAD_SCREENSHOTS
          ? shots
          : Array.from(
              { length: MAX_LOAD_SCREENSHOTS },
              (_, i) => shots[Math.round((i * (shots.length - 1)) / (MAX_LOAD_SCREENSHOTS - 1))]!,
            )
      for (const step of picked) {
        const image = await this.deps.procedures.markedImage(step.screenshotSha as string, step.x, step.y)
        if (image) content.push({ type: 'text', text: `Screenshot of step ${step.position}:` }, image)
      }
      return { content, activity: { detail: entry.name } }
    }
    const scanned = entry.scanned as ScannedSkill
    const body =
      entry.source === 'builtin'
        ? renderBuiltinBody(scanned.body, {
            botSlug: bot.slug,
            engine: this.deps.engine(bot, laneKey),
          })
        : scanned.body
    const parts = [`# Skill: ${entry.slug}`, body.trim()]
    const notes = entry.source === 'builtin' ? this.deps.notes?.(entry.slug) : null
    if (notes?.trim()) parts.push(`## Workspace settings\n${notes.trim()}`)
    const extra = scanned.files.filter((f) => f.path !== 'SKILL.md')
    if (extra.length) {
      const listed = extra
        .slice(0, MAX_LISTED_FILES)
        .map((f) => `- ${f.path} (${sizeText(f.bytes)}${f.executable ? ', executable' : ''})`)
      if (extra.length > MAX_LISTED_FILES) listed.push(`- … and ${extra.length - MAX_LISTED_FILES} more`)
      parts.push(
        [
          '## Files of this skill',
          `Read one with skill_read (name "${entry.slug}", path as listed). In the VM they are in ${vmPathOf(entry.slug)}/ (read-only: run scripts from there; copy a file to /workspace to change it).`,
          ...listed,
        ].join('\n'),
      )
    }
    return { content: [{ type: 'text', text: parts.join('\n\n') }], activity: { detail: entry.slug } }
  }

  private async read(bot: Bot, ref: string, rawPath: string): Promise<ToolResult> {
    const found = this.findForBot(bot, ref)
    if ('problem' in found) return toolError(found.problem)
    const { entry } = found
    const path = safeSkillPath(rawPath)
    if (!path) return toolError('"path" must be a relative path inside the skill, as skill_load lists it.')
    const activity = { detail: `${entry.slug} · ${path}` }
    const files = this.deps.skills.files(entry)
    if (!files.some((f) => f.path === path)) {
      const listed = files.slice(0, 30).map((f) => f.path)
      return toolError(
        `The skill "${entry.slug}" has no file "${path}". Files: ${listed.join(', ') || 'none'}.`,
      )
    }
    if (entry.procedure) {
      const position = Number(TAUGHT_STEP.exec(path)?.[1])
      const step = entry.procedure.steps.find((s) => s.position === position)
      const image = step?.screenshotSha
        ? await this.deps.procedures.markedImage(step.screenshotSha, step.x, step.y)
        : null
      if (!image) return toolError(`The screenshot of step ${position} is no longer available.`)
      return { content: [{ type: 'text', text: `Screenshot of step ${position}:` }, image], activity }
    }
    const scanned = entry.scanned as ScannedSkill
    let bytes: Buffer
    try {
      bytes = readFileSync(join(scanned.dir, ...path.split('/')))
    } catch {
      return toolError(`Could not read "${path}".`)
    }
    const vmPath = `${vmPathOf(entry.slug)}/${path}`
    const image = imageMediaType(bytes)
    if (isThumbnailable(image)) {
      const size = image === 'image/png' ? pngSize(bytes) : jpegSize(bytes)
      if (size && size.width <= MAX_IMAGE_SIDE && size.height <= MAX_IMAGE_SIDE) {
        const sha256 = await this.deps.blobs.put(bytes, image)
        return {
          content: [
            { type: 'text', text: `${path} (${size.width}x${size.height}):` },
            { type: 'image', sha256, mediaType: image, width: size.width, height: size.height },
          ],
          activity,
        }
      }
    }
    let decoded: string | null = null
    if (!bytes.subarray(0, 8192).includes(0)) {
      try {
        decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
      } catch {
        decoded = null
      }
    }
    if (decoded === null)
      return toolError(
        `"${path}" is a binary file (${sizeText(bytes.length)}); use it in the VM at ${vmPath}.`,
      )
    const clipped =
      decoded.length > MAX_TEXT_CHARS
        ? `${decoded.slice(0, MAX_TEXT_CHARS)}\n\n[… truncated: the whole file is in the VM at ${vmPath}]`
        : decoded
    return { content: [{ type: 'text', text: clipped }], activity }
  }

  private async filesFromVm(source: string): Promise<Map<string, NewSkillFile> | string> {
    const normalized = posix.normalize(source.trim()).replace(/\/+$/, '')
    if (!normalized.startsWith('/workspace/')) return '"from_path" must be a folder under /workspace.'
    const guest = await this.deps.vm.guest()
    const listed = await guest.exec({
      user: 'agent',
      cmd: LIST_FOLDER_SCRIPT,
      env: { SRC: normalized },
      timeoutMs: 60_000,
    })
    if (listed.code !== 0) return `Could not read ${normalized}: ${listed.stderr.trim() || 'not a folder'}`
    const entries = listed.stdout
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [size, mode, ...rest] = line.split('\t')
        return { size: Number(size), mode: parseInt(mode ?? '0', 8), path: rest.join('\t') }
      })
    if (entries.length > SKILL_LIMITS.files) return `The folder has more than ${SKILL_LIMITS.files} files.`
    if (entries.reduce((sum, e) => sum + e.size, 0) > SKILL_LIMITS.bytes)
      return `The folder is larger than ${SKILL_LIMITS.bytes / 1024 / 1024} MB.`
    const files = new Map<string, NewSkillFile>()
    for (const file of entries) {
      const path = safeSkillPath(file.path)
      if (!path) continue
      const data = await guest.fsReadAll(`${normalized}/${path}`)
      files.set(path, {
        data,
        executable: (file.mode & 0o111) !== 0 || (data[0] === 0x23 && data[1] === 0x21),
      })
    }
    return files
  }

  private async save(ctx: ToolExecContext, name: string, args: ToolArgs): Promise<ToolResult> {
    const { skills } = this.deps
    const bot = ctx.bot
    const nameError = skillNameError(name)
    if (nameError) return toolError(`Invalid name: ${nameError}`)
    const scope = args.scope === 'all' || args.scope === 'me' ? args.scope : null
    const existing = skills.slugTaken(name)
    if (existing && !(existing.source === 'bot' && existing.row?.author_bot_id === bot.id))
      return toolError(`A skill named "${name}" already exists and is not one of yours: choose another name.`)
    let files = new Map<string, NewSkillFile>()
    const fromPath = textArg(args, 'from_path')
    if (fromPath) {
      const fromVm = await this.filesFromVm(fromPath)
      if (typeof fromVm === 'string') return toolError(fromVm)
      files = fromVm
    }
    for (const item of Array.isArray(args.files) ? args.files : []) {
      const file = item as { path?: unknown; content?: unknown }
      const path = typeof file.path === 'string' ? safeSkillPath(file.path) : null
      if (!path || typeof file.content !== 'string')
        return toolError('Each file needs a relative "path" inside the skill and a text "content".')
      const data = Buffer.from(file.content, 'utf8')
      files.set(path, { data, executable: data[0] === 0x23 && data[1] === 0x21 })
    }
    const description = textArg(args, 'description')
    const body = rawTextArg(args, 'body')
    let skillMd: string
    if (body.trim()) {
      const fromFolder = files.get('SKILL.md')
      const parsed = fromFolder ? parseSkillMd(fromFolder.data.toString('utf8')) : null
      const finalDescription = description || (parsed?.ok ? parsed.meta.description : '')
      if (!finalDescription) return toolError('"description" is required.')
      skillMd = renderSkillMd({ name, description: finalDescription }, body)
    } else {
      const fromFolder = files.get('SKILL.md')
      if (!fromFolder) return toolError('"body" is required (or a SKILL.md in from_path).')
      const parsed = parseSkillMd(fromFolder.data.toString('utf8'))
      if (!parsed.ok) return toolError(`The SKILL.md in from_path is not valid: ${parsed.error}`)
      skillMd =
        parsed.meta.name === name && !description
          ? fromFolder.data.toString('utf8')
          : renderSkillMd(
              { ...parsed.meta, name, description: description || parsed.meta.description },
              parsed.body,
            )
    }
    files.set('SKILL.md', { data: Buffer.from(skillMd, 'utf8'), executable: false })
    const problem = skillFilesProblem(files)
    if (problem) return toolError(`Not saved: ${problem}`)

    const saved = skills.saveFromBot({ bot, name, files, scope, existing })
    if (saved) this.postSavedCard(ctx, saved, files.size, !!existing)
    const shared = saved?.allowed === 'all' ? 'every bot' : 'you only'
    const lines = [
      `Saved the skill "${name}" (${files.size} file${files.size === 1 ? '' : 's'}, for ${shared}). It is in your catalog from your next turn; check it with skill_load.`,
    ]
    if (saved?.error) lines.push(`Warning: ${saved.error}`)
    if (files.size > 1) lines.push(`Its files are mirrored in the VM at ${vmPathOf(name)}/.`)
    return { content: [{ type: 'text', text: lines.join('\n') }], activity: { detail: name } }
  }

  /** The `skill_created` card, in the chat the bot works in (never an internal one), else its DM. */
  private postSavedCard(ctx: ToolExecContext, entry: SkillEntry, files: number, updated: boolean): void {
    if (!this.deps.appendMessage) return
    let conversationId: string
    try {
      conversationId = this.deps.store.conversations.forCard(ctx.bot, ctx.conversationId ?? null)
    } catch {
      return
    }
    this.deps.appendMessage({
      conversationId,
      authorType: 'bot',
      authorBotId: ctx.bot.id,
      kind: 'card',
      content: `${updated ? 'Skill updated' : 'Skill created'}: ${entry.slug}`,
      payload: {
        type: 'skill_created',
        skillId: entry.id,
        botId: ctx.bot.id,
        name: entry.slug,
        description: entry.description,
        scope: entry.allowed === 'all' ? 'all' : 'me',
        files,
        updated,
      },
      turnId: ctx.turnId,
    })
  }

  private delete(bot: Bot, name: string): ToolResult {
    const entry = this.deps.skills.entries().find((e) => e.slug === name)
    if (!entry) return toolError(`No skill named "${name}".`)
    this.deps.skills.remove(entry.id, { bot })
    return { content: [{ type: 'text', text: `Deleted the skill "${name}".` }], activity: { detail: name } }
  }
}

function skillName(a: ToolArgs): string {
  const name = textArg(a, 'name')
  if (!name) throw new ToolInputError('"name" is required')
  return name
}
