import {
  type CliEngine,
  SKILL_LIMITS,
  SKILL_NAME_PATTERN,
  type SkillErrorCode,
  type SkillErrorParams,
  slugify,
} from '@milibot/shared'
import { dump, load } from 'js-yaml'

import { isToolFamily } from '../tools/policy'

export interface SkillMeta {
  name: string
  description: string
  license: string | null
  metadata: Record<string, unknown> | null
  /** Milibot extension, honored only for built-ins. */
  milibot: { tools: string[]; default: 'all' | 'first' } | null
}

/** An invalid skill: the English message (bots, logs) and the code the app translates. */
export interface SkillProblem {
  error: string
  code: SkillErrorCode
  params: SkillErrorParams | null
}

export type ParsedSkillMd = { ok: true; meta: SkillMeta; body: string } | ({ ok: false } & SkillProblem)

function problem(code: SkillErrorCode, error: string, params: SkillErrorParams | null = null) {
  return { ok: false as const, error, code, params }
}

const FRONTMATTER = /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/

export function skillNameError(name: string): string | null {
  if (!name) return 'The name is empty.'
  if (name.length > SKILL_LIMITS.nameLength)
    return `The name has more than ${SKILL_LIMITS.nameLength} characters.`
  if (!SKILL_NAME_PATTERN.test(name))
    return 'The name may only have lowercase letters, digits and single hyphens between them.'
  return null
}

/** Frontmatter + body of a SKILL.md, validated (`name`, `description` and the Milibot extension). */
export function parseSkillMd(text: string): ParsedSkillMd {
  if (Buffer.byteLength(text, 'utf8') > SKILL_LIMITS.skillMdBytes)
    return problem('skill_md_too_large', `SKILL.md is larger than ${SKILL_LIMITS.skillMdBytes / 1024} KB.`, {
      kb: SKILL_LIMITS.skillMdBytes / 1024,
    })
  const match = FRONTMATTER.exec(text)
  if (!match)
    return problem('no_frontmatter', 'SKILL.md must start with a frontmatter block between --- lines.')
  let data: unknown
  try {
    data = load(match[1] as string)
  } catch (err) {
    const detail = (err as Error).message.split('\n')[0] ?? ''
    return problem('invalid_yaml', `The frontmatter is not valid YAML: ${detail}`, { detail })
  }
  if (!data || typeof data !== 'object' || Array.isArray(data))
    return problem('frontmatter_not_fields', 'The frontmatter must be a set of "key: value" fields.')
  const fields = data as Record<string, unknown>
  const name = typeof fields.name === 'string' ? fields.name.trim() : ''
  const nameError = skillNameError(name)
  if (nameError)
    return !name
      ? problem('name_empty', `name: ${nameError}`)
      : name.length > SKILL_LIMITS.nameLength
        ? problem('name_too_long', `name: ${nameError}`, { max: SKILL_LIMITS.nameLength })
        : problem('name_invalid', `name: ${nameError}`)
  const description = typeof fields.description === 'string' ? fields.description.trim() : ''
  if (!description) return problem('description_missing', 'description is required.')
  if (description.length > SKILL_LIMITS.descriptionLength)
    return problem(
      'description_too_long',
      `description has more than ${SKILL_LIMITS.descriptionLength} characters.`,
      { max: SKILL_LIMITS.descriptionLength },
    )
  const metadata =
    fields.metadata && typeof fields.metadata === 'object' && !Array.isArray(fields.metadata)
      ? (fields.metadata as Record<string, unknown>)
      : null
  const milibot = parseMilibotExtension(fields.milibot)
  if (typeof milibot === 'string') return problem('invalid_extension', milibot)
  return {
    ok: true,
    meta: {
      name,
      description,
      license: typeof fields.license === 'string' ? fields.license : null,
      metadata,
      milibot,
    },
    body: text.slice(match[0].length).replace(/^\s*\n/, ''),
  }
}

function parseMilibotExtension(value: unknown): SkillMeta['milibot'] | string {
  if (value === undefined || value === null) return null
  if (typeof value !== 'object' || Array.isArray(value)) return 'milibot must be a set of fields.'
  const fields = value as Record<string, unknown>
  const tools = fields.tools ?? []
  if (!Array.isArray(tools) || tools.some((t) => typeof t !== 'string' || !isToolFamily(t)))
    return 'milibot.tools must list tool families.'
  const byDefault = fields.default ?? 'all'
  if (byDefault !== 'all' && byDefault !== 'first') return 'milibot.default must be "all" or "first".'
  return { tools: tools as string[], default: byDefault }
}

/**
 * The SKILL.md with its frontmatter `name` set to `name` (other fields kept, the Milibot extension dropped):
 * imports that come in under another name or whose name is not a valid skill name. Null without a readable
 * frontmatter.
 */
export function withSkillName(text: string, name: string): string | null {
  const match = FRONTMATTER.exec(text)
  if (!match) return null
  let data: unknown
  try {
    data = load(match[1] as string)
  } catch {
    return null
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null
  const { milibot: _milibot, name: _name, ...rest } = data as Record<string, unknown>
  const frontmatter = dump({ name, ...rest }, { lineWidth: -1 }).trimEnd()
  return `---\n${frontmatter}\n---\n${text.slice(match[0].length)}`
}

/** A SKILL.md written by Milibot (the app's editor, `skill_save`, duplicates). */
export function renderSkillMd(
  meta: {
    name: string
    description: string
    license?: string | null
    metadata?: Record<string, unknown> | null
  },
  body: string,
): string {
  const lines = ['---', `name: ${meta.name}`, `description: ${JSON.stringify(meta.description)}`]
  if (meta.license) lines.push(`license: ${JSON.stringify(meta.license)}`)
  if (meta.metadata && Object.keys(meta.metadata).length)
    lines.push(`metadata: ${JSON.stringify(meta.metadata)}`)
  lines.push('---', '')
  return `${lines.join('\n')}${body.trim()}\n`
}

/**
 * Built-in skill bodies depend on the bot: `{{bot_slug}}`, `{{#claude_code}}…{{/claude_code}}` /
 * `{{^claude_code}}…{{/claude_code}}` for text that applies only to Claude Code bots or only to the others, and
 * `{{#cli}}…{{/cli}}` / `{{^cli}}…{{/cli}}` for any CLI engine (Claude Code, Codex) or the native loop.
 */
export function renderBuiltinBody(body: string, ctx: { botSlug: string; engine: CliEngine | null }): string {
  const section = (tag: string, on: boolean) => (text: string) =>
    text.replace(
      new RegExp(`\\{\\{([#^])${tag}\\}\\}([\\s\\S]*?)\\{\\{\\/${tag}\\}\\}`, 'g'),
      (_, mode: string, inner: string) => ((mode === '#') === on ? inner : ''),
    )
  return [section('claude_code', ctx.engine === 'claude_code'), section('cli', ctx.engine !== null)]
    .reduce((text, apply) => apply(text), body)
    .replace(/\{\{bot_slug\}\}/g, ctx.botSlug)
    .replace(/\n{3,}/g, '\n\n')
}

/** Lowercase ASCII slug for a skill name (taught procedures, suggestions). */
export function slugifySkillName(text: string): string {
  return slugify(text, { maxLength: SKILL_LIMITS.nameLength, fallback: 'skill' })
}

/**
 * A skill file's path, `/`-separated and relative to the skill folder; null when it would escape it or is
 * not a plain relative path (a `:` would be a drive or an alternate data stream on Windows).
 */
export function safeSkillPath(path: string): string | null {
  const trimmed = path.trim().replace(/^\.\/+/, '')
  if (
    !trimmed ||
    trimmed.startsWith('/') ||
    trimmed.includes('\\') ||
    trimmed.includes(':') ||
    trimmed.includes('\0')
  )
    return null
  const parts = trimmed.split('/').filter((p) => p !== '' && p !== '.')
  if (parts.length === 0 || parts.some((p) => p === '..')) return null
  return parts.join('/')
}

const SCRIPT_EXTENSIONS = /\.(sh|bash|zsh|py|js|mjs|cjs|ts|rb|pl|php)$/i

/** Scripts the bots run in the VM: executable, starting with a shebang or with a script extension. */
export function looksLikeScript(path: string, head: Uint8Array, executable: boolean): boolean {
  return executable || (head[0] === 0x23 && head[1] === 0x21) || SCRIPT_EXTENSIONS.test(path)
}
