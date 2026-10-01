import type { ContentPart } from '@milibot/agent/llm'
import { type DesignToolName, numberArg, textArg, toolText } from '@milibot/agent/tools'

import { resolveWorkspacePath } from '../../code'
import type { ToolHandler } from '../../tools-core'
import { fileSlug } from '../format'
import type { ExportFormat } from '../output'
import { resolveTheme } from '../resolve'
import type { DesignRow, FrameRow } from '../store'
import { DesignInputError } from '../tokens'
import type { DesignToolsDeps } from './deps'

const MAX_SCREENSHOT_FRAMES = 4
const EXPORT_FORMATS: readonly string[] = ['png', 'pdf', 'html'] satisfies ExportFormat[]

type OutputHandlers = Pick<Record<DesignToolName, ToolHandler>, 'design_screenshot' | 'design_export'>

/** Screenshots for the bot and exports into the VM. */
export function outputHandlers({ designs }: DesignToolsDeps): OutputHandlers {
  /** The frames named by `raw` (a name, an id or a list of them); all of them (up to `max`) when absent. */
  const frameList = (design: DesignRow, raw: unknown, max: number | null): FrameRow[] => {
    if (raw === undefined || raw === null || (Array.isArray(raw) && raw.length === 0)) {
      const all = designs.store.frames(design.id)
      if (all.length === 0) throw new DesignInputError(`"${design.name}" has no frames yet`)
      return max ? all.slice(0, max) : all
    }
    const refs = Array.isArray(raw) ? raw : [raw]
    if (max && refs.length > max) throw new DesignInputError(`at most ${max} frames per call`)
    return refs.map((ref) => designs.resolveFrame(design, typeof ref === 'string' ? ref.trim() : ''))
  }

  return {
    design_screenshot: async (ctx, a) => {
      const design = designs.resolve(ctx, textArg(a, 'design'))
      const frames = frameList(design, a.frames, MAX_SCREENSHOT_FRAMES)
      const theme = resolveTheme(design, textArg(a, 'theme'))
      const scale = numberArg(a, 'scale', { min: 0.25, max: 2, fallback: 1 })
      const content: ContentPart[] = []
      for (const frame of frames) {
        designs.frames.presence(ctx, design.id, frame.id, true, 'read')
        try {
          content.push(...(await designs.output.screenshot(design, frame, theme, scale)))
        } finally {
          designs.frames.presence(ctx, design.id, frame.id, false, 'read')
        }
      }
      return { content, activity: { detail: `${design.name} · ${frames.map((f) => f.name).join(', ')}` } }
    },

    design_export: async (ctx, a) => {
      const design = designs.resolve(ctx, textArg(a, 'design'))
      const format = textArg(a, 'format')
      if (!EXPORT_FORMATS.includes(format)) throw new DesignInputError('"format" must be png, pdf or html')
      const path = resolveWorkspacePath(textArg(a, 'path') || `/workspace/designs/${fileSlug(design.name)}`)
      if (!path) throw new DesignInputError('"path" must be under /workspace')
      const frames = frameList(design, a.frames, null)
      const scale = numberArg(a, 'scale', { min: 0.5, max: 3, fallback: 2 })
      const written = await designs.output.export(
        ctx.bot,
        design,
        frames,
        format as ExportFormat,
        path,
        scale,
      )
      const note =
        format === 'html'
          ? '\n<name>.html renders on its own (fonts and images embedded); <name>.source.html is the frame as written ' +
            '(Tailwind classes, tokens from tokens.css, Lucide icons as data-icon, drawings as data-art="<name>" = ' +
            'art/<name>.svg); read those to implement it.'
          : ''
      return toolText(
        `Exported ${frames.length} frame${frames.length === 1 ? '' : 's'} of "${design.name}":\n${written.map((f) => `- ${f}`).join('\n')}${note}`,
        false,
        { detail: design.name },
      )
    },
  }
}
