import { z } from 'zod'

import { UserOrBot } from '../core/schemas'
import { endpoint, Ok, queryBool } from '../http/endpoint'

/*
 * Designs: screens, slides and documents bots draw on an infinite canvas. A design has named themes (ordered,
 * the first is the default), tokens (CSS variables that are also Tailwind utilities) with one value per
 * theme or one for all, and frames (HTML + Tailwind classes, an optional CSS block, a size and a theme).
 */

export const DESIGN_LIMITS = {
  themes: 12,
  tokens: 200,
  fonts: 8,
  frames: 200,
  frameHtmlBytes: 400 * 1024,
  frameCssBytes: 100 * 1024,
  frameSide: 10_000,
  revisions: 50,
} as const

/** Slide (16:9, 4:3) and printed page (A series, US Letter) proportions, either orientation. */
const PAGED_RATIOS = [16 / 9, 4 / 3, Math.SQRT2, 11 / 8.5]

/** Slides and printed pages must fit their content; other fixed heights are screens that grow. */
export function isPagedSize(width: number, height: number): boolean {
  const ratio = Math.max(width, height) / Math.min(width, height)
  return PAGED_RATIOS.some((r) => Math.abs(ratio - r) < 0.02)
}

export const DesignTokenType = z.enum(['color', 'number', 'string', 'font'])
export type DesignTokenType = z.infer<typeof DesignTokenType>

export const DesignTokenValue = z.union([z.string().max(2000), z.number()])
export type DesignTokenValue = z.infer<typeof DesignTokenValue>

/** A CSS variable of the design (`name` without `--`, e.g. `color-primary`, `radius-card`). */
export const DesignToken = z.object({
  name: z.string(),
  type: DesignTokenType,
  /** The same value in every theme (null when per theme). */
  value: DesignTokenValue.nullable(),
  /** Value per theme name (themes missing here use `value`, else the first theme's). */
  values: z.record(z.string(), DesignTokenValue),
})
export type DesignToken = z.infer<typeof DesignToken>

export const DesignArtStatus = z.enum(['drawing', 'ready', 'failed'])
export type DesignArtStatus = z.infer<typeof DesignArtStatus>

export const DESIGN_ART_LIMITS = { side: { min: 32, max: 2048 }, prompt: { min: 20, max: 2000 } } as const

export const DesignFrame = z.object({
  id: z.string(),
  designId: z.string(),
  name: z.string(),
  x: z.number().int(),
  y: z.number().int(),
  width: z.number().int(),
  /** null: grows with its content (`auto`). */
  height: z.number().int().nullable(),
  measuredHeight: z.number().int().nullable(),
  /** null (or a theme that no longer exists) = the design's first theme. */
  theme: z.string().nullable(),
  position: z.number().int(),
  updatedAt: z.number().int(),
  /** Drawn by `design_draw` in the background, not HTML a bot writes. */
  art: z.object({ status: DesignArtStatus, botId: z.string().nullable() }).optional(),
})
export type DesignFrame = z.infer<typeof DesignFrame>

/** A design without its frames' HTML (events, lists). */
export const Design = z.object({
  id: z.string(),
  name: z.string(),
  conversationId: z.string().nullable(),
  botId: z.string().nullable(),
  themes: z.array(z.string()),
  tokens: z.array(DesignToken),
  fonts: z.array(z.string()),
  frameCount: z.number().int(),
  thumbnailSha: z.string().nullable(),
  /** Archived designs leave what bots list unless they ask for them. */
  archivedAt: z.number().int().nullable(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
})
export type Design = z.infer<typeof Design>

export const DesignDetail = Design.extend({ frames: z.array(DesignFrame) })
export type DesignDetail = z.infer<typeof DesignDetail>

export const DesignProblemKind = z.enum([
  'text_overflow',
  'outside_frame',
  'overlap',
  'image_failed',
  'unknown_icon',
  'font_unavailable',
  'css_error',
  'asset_missing',
  'art_pending',
  'art_failed',
  'unknown_art',
])
export type DesignProblemKind = z.infer<typeof DesignProblemKind>

export const DesignProblem = z.object({
  kind: DesignProblemKind,
  message: z.string(),
})
export type DesignProblem = z.infer<typeof DesignProblem>

/** The compiled, self-contained document of a frame (shown in an `<iframe sandbox srcdoc>`). */
export const DesignFrameHtml = z.object({
  frameId: z.string(),
  theme: z.string(),
  width: z.number().int(),
  height: z.number().int().nullable(),
  html: z.string(),
  problems: z.array(DesignProblem),
})
export type DesignFrameHtml = z.infer<typeof DesignFrameHtml>

export const DesignRevision = z.object({
  id: z.string(),
  designId: z.string(),
  /** null: themes/tokens/fonts. */
  frameId: z.string().nullable(),
  authorType: UserOrBot,
  authorBotId: z.string().nullable(),
  turnId: z.string().nullable(),
  /** What changed, in English ("frame Home written", "tokens: color-primary"). */
  summary: z.string(),
  createdAt: z.number().int(),
})
export type DesignRevision = z.infer<typeof DesignRevision>

const ListDesignsQuery = z.object({
  conversationId: z.string().optional(),
  botId: z.string().optional(),
  archived: queryBool(false),
})

const ArchiveDesignBody = z.object({ archived: z.boolean() })

const RenameDesignBody = z.object({ name: z.string().trim().min(1).max(120) })

const DesignFrameHtmlQuery = z.object({ theme: z.string().optional() })

/** The user dragged a frame: saved at the nearest free spot. */
const MoveDesignFrameBody = z.object({
  x: z.number().int().min(-1_000_000).max(1_000_000),
  y: z.number().int().min(-1_000_000).max(1_000_000),
})

/** `undo`: back to the state before that revision instead of the state it saved. */
const RestoreDesignRevisionBody = z.object({ undo: z.boolean().optional() })

/** A frame for whoever implements it: the standalone page, the source as written and the tokens file. */
export const DesignFrameSource = z.object({
  frameId: z.string(),
  name: z.string(),
  theme: z.string(),
  /** Self-contained page (fonts, icons and images embedded). */
  html: z.string(),
  /** The frame as written: Tailwind classes, tokens from `tokens.css`, `data-icon` icons. */
  source: z.string(),
  tokensCss: z.string(),
})
export type DesignFrameSource = z.infer<typeof DesignFrameSource>

/** New values of existing tokens: `{name: {theme: value}}`; theme `*` sets one value for every theme. */
const UpdateDesignTokensBody = z.object({
  values: z.record(z.string(), z.record(z.string(), DesignTokenValue)),
})

/** A design exported to move it to another workspace (a zip). */
export const DESIGN_FILE_EXTENSION = 'mbdesign'
export const DESIGN_FILE_FORMAT = 'milibot-design'
export const DESIGN_FILE_VERSION = 1

/** `manifest.json` of a `.mbdesign`. */
export const DesignFileManifest = z.object({
  format: z.literal(DESIGN_FILE_FORMAT),
  formatVersion: z.number().int().min(1),
  exportedAt: z.number().int(),
})
export type DesignFileManifest = z.infer<typeof DesignFileManifest>

/** `design.json` of a `.mbdesign`: the look and the frames (sources in `frames/<file>.html|css`). */
export const DesignFileContent = z.object({
  name: z.string().min(1).max(120),
  themes: z.array(z.string()).min(1).max(DESIGN_LIMITS.themes),
  tokens: z.array(DesignToken).max(DESIGN_LIMITS.tokens),
  fonts: z.array(z.string()).max(DESIGN_LIMITS.fonts),
  frames: z
    .array(
      z.object({
        file: z.string().regex(/^[a-z0-9-]{1,40}$/),
        name: z.string().min(1).max(80),
        x: z.number().int().min(-1_000_000).max(1_000_000),
        y: z.number().int().min(-1_000_000).max(1_000_000),
        width: z.number().int().min(16).max(DESIGN_LIMITS.frameSide),
        height: z.number().int().min(16).max(DESIGN_LIMITS.frameSide).nullable(),
        theme: z.string().nullable(),
        art: z.object({ prompt: z.string().max(DESIGN_ART_LIMITS.prompt.max) }).optional(),
      }),
    )
    .max(DESIGN_LIMITS.frames),
})
export type DesignFileContent = z.infer<typeof DesignFileContent>

/** Writes the design (or only `frameIds`) to `path`, an absolute `.mbdesign` path. */
const ExportDesignBody = z.object({
  path: z.string().min(1),
  frameIds: z.array(z.string()).min(1).optional(),
})

/** A `.mbdesign` becomes a new design in the conversation, with its card. */
const ImportDesignBody = z.object({ path: z.string().min(1), conversationId: z.string() })

export const designEndpoints = {
  /** Newest first. */
  listDesigns: endpoint({
    method: 'GET',
    path: '/w/:workspaceId/designs',
    query: ListDesignsQuery,
    response: z.array(Design),
  }),
  getDesign: endpoint({ method: 'GET', path: '/w/:workspaceId/designs/:designId', response: DesignDetail }),
  getDesignFrameHtml: endpoint({
    method: 'GET',
    path: '/w/:workspaceId/designs/:designId/frames/:frameId/html',
    query: DesignFrameHtmlQuery,
    response: DesignFrameHtml,
  }),
  getDesignFrameSource: endpoint({
    method: 'GET',
    path: '/w/:workspaceId/designs/:designId/frames/:frameId/source',
    response: DesignFrameSource,
  }),
  moveDesignFrame: endpoint({
    method: 'PATCH',
    path: '/w/:workspaceId/designs/:designId/frames/:frameId',
    body: MoveDesignFrameBody,
    response: DesignFrame,
  }),
  updateDesignTokens: endpoint({
    method: 'PATCH',
    path: '/w/:workspaceId/designs/:designId/tokens',
    body: UpdateDesignTokensBody,
    response: Design,
  }),
  listDesignRevisions: endpoint({
    method: 'GET',
    path: '/w/:workspaceId/designs/:designId/revisions',
    response: z.array(DesignRevision),
  }),
  restoreDesignRevision: endpoint({
    method: 'POST',
    path: '/w/:workspaceId/designs/:designId/revisions/:revisionId/restore',
    body: RestoreDesignRevisionBody,
    response: DesignDetail,
  }),
  archiveDesign: endpoint({
    method: 'PATCH',
    path: '/w/:workspaceId/designs/:designId',
    body: ArchiveDesignBody,
    response: Design,
  }),
  renameDesign: endpoint({
    method: 'POST',
    path: '/w/:workspaceId/designs/:designId/rename',
    body: RenameDesignBody,
    response: Design,
  }),
  deleteDesign: endpoint({ method: 'DELETE', path: '/w/:workspaceId/designs/:designId', response: Ok }),
  exportDesign: endpoint({
    method: 'POST',
    path: '/w/:workspaceId/designs/:designId/export',
    body: ExportDesignBody,
    response: Ok,
  }),
  importDesign: endpoint({
    method: 'POST',
    path: '/w/:workspaceId/designs/import',
    body: ImportDesignBody,
    response: Design,
  }),
}
