import type { ToolExecContext } from '@milibot/agent'
import { type DesignToolName, flagArg, textArg, type ToolArgs, toolText } from '@milibot/agent/tools'

import type { ToolHandler } from '../../tools-core'
import { artState, frameSize } from '../format'
import { artInfo, type DesignRow, type FrameRow, lookOf } from '../store'
import {
  applyTokenChanges,
  checkThemes,
  DesignInputError,
  findTheme,
  parseTokenChanges,
  tokensTable,
} from '../tokens'
import { fontList } from './args'
import type { DesignToolsDeps } from './deps'

type DesignHandlers = Pick<
  Record<DesignToolName, ToolHandler>,
  'design_create' | 'design_list' | 'design_read' | 'design_set_tokens' | 'design_archive' | 'design_delete'
>

/** Designs as a whole: create, list, read, look (themes, tokens, fonts), archive, delete. */
export function designHandlers(deps: DesignToolsDeps): DesignHandlers {
  const { designs } = deps
  const store = designs.store

  const describeDesign = (row: DesignRow): string => {
    const look = lookOf(row)
    const frames = store.frames(row.id)
    const lines = [
      `Design "${row.name}" (${row.id})`,
      `Themes: ${look.themes.map((t, i) => (i === 0 ? `${t} (default)` : t)).join(', ')}`,
      `Fonts: ${look.fonts.length ? look.fonts.join(', ') : 'Inter (default)'}`,
      tokensTable(look.tokens, look.themes),
      frames.length ? `Frames (in order):` : 'Frames: none yet.',
      ...frames.map(
        (f) =>
          `- ${f.name} (${f.id}) ${frameSize(f)} at (${f.x}, ${f.y}) · ` +
          (f.art_status
            ? artState(f, designs.now())
            : `theme ${findTheme(look.themes, f.theme ?? '') ?? look.themes[0]}`),
      ),
    ]
    const userChanges: string[] = []
    for (const r of store.revisions(row.id)) {
      if (r.authorType === 'bot') break
      userChanges.push(r.summary)
    }
    if (userChanges.length)
      lines.push(`Changed by the user since the last bot change: ${userChanges.slice(0, 5).join('; ')}`)
    return lines.join('\n')
  }

  const readFrame = async (ctx: ToolExecContext, design: DesignRow, frame: FrameRow, header: string) => {
    if (frame.art_status) {
      const info = artInfo(frame)
      return toolText(
        [
          header,
          `\nArt frame "${frame.name}" (${frame.id}) ${frameSize(frame)} · ${artState(frame, designs.now())}`,
          `Brief: ${info?.prompt ?? ''}`,
          `Place it in a frame with <img data-art="${frame.name}" alt="…" class="h-10 w-auto">; redraw it with design_draw and the same name.`,
        ].join('\n'),
        false,
        { detail: `${design.name} · ${frame.name}` },
      )
    }
    const parts = [
      header,
      `\nFrame "${frame.name}" (${frame.id}) ${frameSize(frame)}:`,
      '```html',
      frame.html,
      '```',
    ]
    if (frame.css.trim()) parts.push('```css', frame.css, '```')
    parts.push((await designs.layout.check(design, frame, ctx.signal)).text)
    return toolText(parts.join('\n'), false, { detail: `${design.name} · ${frame.name}` })
  }

  const renames = (a: ToolArgs): Array<[string, string]> => {
    const raw = a.rename_themes
    if (raw === undefined || raw === null) return []
    if (typeof raw !== 'object' || Array.isArray(raw))
      throw new DesignInputError('"rename_themes" must be an object {old: new}')
    return Object.entries(raw as Record<string, unknown>).map(([from, to]) => [
      from,
      typeof to === 'string' ? to.trim() : '',
    ])
  }

  return {
    design_create: (ctx, a) => {
      const name = textArg(a, 'name', 120)
      if (!name) throw new DesignInputError('"name" is required')
      const themes = a.themes === undefined || a.themes === null ? ['Default'] : checkThemes(a.themes)
      const { tokens } = applyTokenChanges([], parseTokenChanges(a.tokens), themes)
      const fonts = fontList(a.fonts)
      const row = designs.createDesign({
        look: { name, themes, tokens, fonts },
        conversationId: deps.cardConversation(ctx.bot, ctx.conversationId),
        bot: ctx.bot,
        turnId: ctx.turnId,
      })
      designs.emitDesign(row)
      return toolText(
        `Created the design "${name}" (${row.id}). Themes: ${themes.join(', ')}. Tokens: ${tokens.length}. ` +
          'Add frames with design_write_frame.',
        false,
        { detail: name },
      )
    },

    design_list: (_ctx, a) => {
      const archived = flagArg(a, 'archived') === true
      const rows = store.rows({ archived })
      if (rows.length === 0)
        return toolText(
          archived
            ? 'There are no designs yet (design_create makes one).'
            : 'There are no active designs (archived: true lists the archived ones too).',
        )
      const lines = rows.slice(0, 100).map((r) => {
        const look = lookOf(r)
        const frames = store.frames(r.id)
        const author = r.bot_id ? (deps.getBot(r.bot_id)?.name ?? 'a deleted bot') : 'the user'
        return (
          `- ${r.name} (${r.id}) · ${frames.length} frame${frames.length === 1 ? '' : 's'} · themes ${look.themes.join(', ')} · ` +
          `by ${author} · changed ${new Date(r.updated_at).toISOString().slice(0, 16).replace('T', ' ')}` +
          (r.archived_at !== null ? ' · archived' : '')
        )
      })
      return toolText(lines.join('\n'))
    },

    design_read: async (ctx, a) => {
      const design = designs.resolve(ctx, textArg(a, 'design'))
      const header = describeDesign(design)
      const ref = textArg(a, 'frame')
      if (!ref) return toolText(header, false, { detail: design.name })
      const frame = designs.resolveFrame(design, ref)
      designs.frames.presence(ctx, design.id, frame.id, true, 'read')
      try {
        return await readFrame(ctx, design, frame, header)
      } finally {
        designs.frames.presence(ctx, design.id, frame.id, false, 'read')
      }
    },

    design_set_tokens: (ctx, a) => {
      const design = designs.resolve(ctx, textArg(a, 'design'), true)
      const { after, changed } = designs.changeLook(ctx, design, {
        renames: renames(a),
        themes: a.themes !== undefined && a.themes !== null ? checkThemes(a.themes) : null,
        tokens: parseTokenChanges(a.tokens),
        fonts: a.fonts === undefined || a.fonts === null ? null : fontList(a.fonts),
      })
      return toolText(
        `${changed.length ? `Changed ${changed.join('; ')}.` : 'Nothing changed.'}\n${tokensTable(after.tokens, after.themes)}`,
        false,
        { detail: design.name },
      )
    },

    design_archive: (ctx, a) => {
      const design = designs.resolve(ctx, textArg(a, 'design'))
      const archived = flagArg(a, 'archived') !== false
      designs.archiveDesign(design.id, archived)
      return toolText(
        `${archived ? 'Archived' : 'Unarchived'} the design "${design.name}" (${design.id}).`,
        false,
        { detail: design.name },
      )
    },

    design_delete: (ctx, a) => {
      const design = designs.resolve(ctx, textArg(a, 'design'))
      designs.deleteDesign(design.id)
      return toolText(`Deleted the design "${design.name}" (${design.id}).`, false, { detail: design.name })
    },
  }
}
