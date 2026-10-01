import { z } from 'zod'

import { BotScope } from '../bots/bots'
import { endpoint, Ok } from '../http/endpoint'

/*
 * Skills: folders with a `SKILL.md` (YAML frontmatter + markdown instructions) and optional files that bots
 * load on demand. `<wsDir>/skills/<slug>/` holds the content; the `skills` table holds state (enabled, which
 * bots may use it, where it came from). Built-ins ship with the app; taught procedures are listed too.
 */

export const SKILL_LIMITS = {
  nameLength: 64,
  descriptionLength: 1024,
  skillMdBytes: 60 * 1024,
  files: 500,
  bytes: 20 * 1024 * 1024,
} as const

export const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/** Where skills with files besides SKILL.md are mirrored in the VM (read-only, root-owned). */
export const SKILLS_VM_ROOT = '/usr/local/share/milibot/skills'

export const SkillSource = z.enum(['builtin', 'user', 'import', 'bot', 'taught'])
export type SkillSource = z.infer<typeof SkillSource>

export const SkillFile = z.object({
  /** Relative to the skill folder, `/`-separated. */
  path: z.string(),
  bytes: z.number().int(),
  executable: z.boolean(),
})
export type SkillFile = z.infer<typeof SkillFile>

export const Skill = z.object({
  /** `builtin:<slug>` for built-ins, the procedure id for taught procedures. */
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  description: z.string(),
  source: SkillSource,
  /** Import origin (`{kind, repo, ref, path, sha}`), when imported. */
  origin: z.record(z.string(), z.unknown()).nullable(),
  authorBotId: z.string().nullable(),
  enabled: z.boolean(),
  allowedBots: BotScope,
  /** Built-ins: on by default for every bot, or only for the bot it was turned on for (the first bot). */
  defaultFor: z.enum(['all', 'first']),
  /** Tool families a built-in enables for the bots it is active for. */
  tools: z.array(z.string()),
  toolCount: z.number().int(),
  /** Bots that turned it on themselves (`defaultFor: first` is off for everyone else). */
  enabledFor: z.array(z.string()),
  disabledFor: z.array(z.string()),
  /** Imported from GitHub and a newer version of its folder exists (checked in the background). */
  updateAvailable: z.boolean(),
  /** SKILL.md problem (invalid frontmatter, limits); such a skill is never offered to bots. */
  error: z.string().nullable(),
  editable: z.boolean(),
  /** Of the SKILL.md body. */
  tokens: z.number().int(),
  fileCount: z.number().int(),
  bytes: z.number().int(),
  /** Contains executable files or scripts (they run in the VM). */
  hasScripts: z.boolean(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
})
export type Skill = z.infer<typeof Skill>

export const SkillDetail = Skill.extend({
  /** Whole SKILL.md (frontmatter included); null for taught procedures. */
  skillMd: z.string().nullable(),
  files: z.array(SkillFile),
  /** Folder in the VM when its files are mirrored there. */
  vmPath: z.string().nullable(),
  /** Its folder on the host (null for taught procedures). */
  folderPath: z.string().nullable(),
})
export type SkillDetail = z.infer<typeof SkillDetail>

export const SkillsFolder = z.object({
  /** `<wsDir>/skills` on the host. */
  path: z.string(),
  vmPath: z.string(),
})
export type SkillsFolder = z.infer<typeof SkillsFolder>

/** A skill as one bot sees it. */
export const BotSkill = z.object({
  skill: Skill,
  /** The bot's own switch (no choice stored: the skill's default). */
  enabled: z.boolean(),
  allowed: z.boolean(),
  /** In the bot's catalog: valid, enabled in the workspace, allowed and enabled for the bot. */
  active: z.boolean(),
})
export type BotSkill = z.infer<typeof BotSkill>

export const UpdateSkillBody = z.object({
  enabled: z.boolean().optional(),
  allowedBots: BotScope.optional(),
})
export type UpdateSkillBody = z.input<typeof UpdateSkillBody>

const PutSkillContentBody = z.object({
  skillMd: z.string().max(SKILL_LIMITS.skillMdBytes),
})

export const CreateSkillBody = z.object({
  name: z.string().trim().min(1).max(SKILL_LIMITS.nameLength),
  description: z.string().trim().min(1).max(SKILL_LIMITS.descriptionLength),
  body: z.string().max(SKILL_LIMITS.skillMdBytes),
  allowedBots: BotScope.optional(),
})
export type CreateSkillBody = z.input<typeof CreateSkillBody>

const UpdateBotSkillBody = z.object({ enabled: z.boolean() })

/** Paths on the host, a GitHub repo, or another workspace. */
export const SkillImportSource = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('paths'), paths: z.array(z.string().min(1).max(4096)).min(1).max(50) }),
  z.object({ kind: z.literal('github'), url: z.string().trim().min(1).max(2048) }),
  z.object({ kind: z.literal('workspace'), workspaceId: z.string().min(1).max(100) }),
])
export type SkillImportSource = z.infer<typeof SkillImportSource>

/**
 * `update`: replaces the skill imported from the same place; `name_taken`: another skill has the name, it
 * comes in as `importAs`; `similar_builtin`: a skill included in Milibot has the name (also renamed).
 */
export const SkillImportConflict = z.enum(['none', 'update', 'name_taken', 'similar_builtin'])
export type SkillImportConflict = z.infer<typeof SkillImportConflict>

/** Why a skill cannot be imported (`params` fill the app's message). */
export const SkillErrorCode = z.enum([
  'too_many_files',
  'too_large',
  'skill_md_missing',
  'skill_md_too_large',
  'no_frontmatter',
  'invalid_yaml',
  'frontmatter_not_fields',
  'name_empty',
  'name_too_long',
  'name_invalid',
  'description_missing',
  'description_too_long',
  'invalid_extension',
  'not_in_scan',
  'install_failed',
])
export type SkillErrorCode = z.infer<typeof SkillErrorCode>

export const SkillErrorParams = z.record(z.string(), z.union([z.string(), z.number()]))
export type SkillErrorParams = z.infer<typeof SkillErrorParams>

export const SkillImportCandidate = z.object({
  /** Key of the candidate in the scan (folder inside the repo/zip, or path on the host). */
  path: z.string(),
  name: z.string(),
  description: z.string(),
  files: z.number().int(),
  bytes: z.number().int(),
  hasScripts: z.boolean(),
  conflict: SkillImportConflict,
  importAs: z.string(),
  /** The skill it replaces (`update`) or clashes with. */
  existingSkillId: z.string().nullable(),
  /** English; `errorCode` for the app. */
  error: z.string().nullable(),
  errorCode: SkillErrorCode.nullable(),
  errorParams: SkillErrorParams.nullable(),
})
export type SkillImportCandidate = z.infer<typeof SkillImportCandidate>

export const SkillImportScan = z.object({
  scanId: z.string(),
  origin: z.object({
    kind: z.enum(['paths', 'github', 'workspace']),
    label: z.string(),
    ref: z.string().nullable(),
    sha: z.string().nullable(),
  }),
  candidates: z.array(SkillImportCandidate),
  expiresAt: z.number().int(),
})
export type SkillImportScan = z.infer<typeof SkillImportScan>

const SkillImportScanBody = z.object({ source: SkillImportSource })

const SkillImportCommitBody = z.object({
  scanId: z.string().min(1),
  paths: z.array(z.string()).min(1).max(SKILL_LIMITS.files),
  allowedBots: BotScope.default('all'),
})

export const SkillImportCommitResult = z.object({
  imported: z.array(Skill),
  failed: z.array(
    z.object({
      path: z.string(),
      error: z.string(),
      code: SkillErrorCode,
      params: SkillErrorParams.nullable(),
    }),
  ),
})
export type SkillImportCommitResult = z.infer<typeof SkillImportCommitResult>

const UpdateSkillSourceBody = z.object({
  /** false: only checks for a newer version; true: also replaces the files with it. */
  apply: z.boolean().default(false),
})

export const SkillSourceCheck = z.object({
  updateAvailable: z.boolean(),
  /** Commit the skill came from / the latest commit that touched its folder (GitHub). */
  sha: z.string().nullable(),
  latestSha: z.string().nullable(),
  updated: z.boolean(),
  skill: SkillDetail,
})
export type SkillSourceCheck = z.infer<typeof SkillSourceCheck>

/** `skill_load` calls of the skill in the last `days` days, per bot. */
export const SkillUsage = z.object({
  days: z.number().int(),
  loads: z.number().int(),
  bots: z.array(z.object({ botId: z.string(), count: z.number().int() })),
})
export type SkillUsage = z.infer<typeof SkillUsage>

/** Where an imported skill came from (`Skill.origin`). */
export interface SkillOrigin {
  kind: 'path' | 'zip' | 'github' | 'workspace'
  repo?: string | null
  ref?: string | null
  /** Folder of the skill inside the repo, zip or workspace ('' = the root). */
  path?: string | null
  sha?: string | null
  /** Newest commit that had changed the skill's folder when it was imported (GitHub). */
  pathSha?: string | null
  /** Folder, SKILL.md or zip on the host. */
  localPath?: string | null
  workspaceId?: string | null
  importedAt?: number | null
  /** Newest commit that changed the skill's folder, when newer than the imported one. */
  latestSha?: string | null
  latestAt?: number | null
  checkedAt?: number | null
}

export const skillEndpoints = {
  /** Every skill (built-in, user, imported, bot-made, taught), including invalid ones with their error. */
  listSkills: endpoint({ method: 'GET', path: '/w/:workspaceId/skills', response: z.array(Skill) }),
  /** The user can copy skill folders into it. */
  getSkillsFolder: endpoint({ method: 'GET', path: '/w/:workspaceId/skills-folder', response: SkillsFolder }),
  /** Source `user`. */
  createSkill: endpoint({
    method: 'POST',
    path: '/w/:workspaceId/skills',
    body: CreateSkillBody,
    response: SkillDetail,
  }),
  getSkill: endpoint({ method: 'GET', path: '/w/:workspaceId/skills/:skillId', response: SkillDetail }),
  updateSkill: endpoint({
    method: 'PATCH',
    path: '/w/:workspaceId/skills/:skillId',
    body: UpdateSkillBody,
    response: Skill,
  }),
  /** Replaces SKILL.md (user, imported and bot-made skills). */
  putSkillContent: endpoint({
    method: 'PUT',
    path: '/w/:workspaceId/skills/:skillId/content',
    body: PutSkillContentBody,
    response: SkillDetail,
  }),
  /** Deletes the skill and its folder (not built-ins; taught procedures are deleted as procedures). */
  deleteSkill: endpoint({ method: 'DELETE', path: '/w/:workspaceId/skills/:skillId', response: Ok }),
  /** Editable copy (source `user`), e.g. of a built-in. */
  duplicateSkill: endpoint({
    method: 'POST',
    path: '/w/:workspaceId/skills/:skillId/duplicate',
    response: SkillDetail,
  }),
  /** Finds the skills in a folder, SKILL.md or zip on the host, a GitHub repo or another workspace. */
  scanSkillImport: endpoint({
    method: 'POST',
    path: '/w/:workspaceId/skills/import/scan',
    body: SkillImportScanBody,
    response: SkillImportScan,
  }),
  commitSkillImport: endpoint({
    method: 'POST',
    path: '/w/:workspaceId/skills/import/commit',
    body: SkillImportCommitBody,
    response: SkillImportCommitResult,
  }),
  /** Looks for a newer version where an imported skill came from and, with `apply`, takes it. */
  updateSkillSource: endpoint({
    method: 'POST',
    path: '/w/:workspaceId/skills/:skillId/update-source',
    body: UpdateSkillSourceBody,
    response: SkillSourceCheck,
  }),
  getSkillUsage: endpoint({
    method: 'GET',
    path: '/w/:workspaceId/skills/:skillId/usage',
    response: SkillUsage,
  }),
  listBotSkills: endpoint({
    method: 'GET',
    path: '/w/:workspaceId/bots/:botId/skills',
    response: z.array(BotSkill),
  }),
  updateBotSkill: endpoint({
    method: 'PATCH',
    path: '/w/:workspaceId/bots/:botId/skills/:skillId',
    body: UpdateBotSkillBody,
    response: BotSkill,
  }),
}
