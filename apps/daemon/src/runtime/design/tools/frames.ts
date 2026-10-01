import {
  type DesignToolName,
  optionalIntLike,
  rawTextArg,
  textArg,
  type ToolArgs,
  toolText,
} from '@milibot/agent/tools'
import { DESIGN_ART_LIMITS } from '@milibot/shared'

import type { ToolHandler } from '../../tools-core'
import { artOnly, frameSize } from '../format'
import { resolveTheme } from '../resolve'
import { lookOf } from '../store'
import { DesignInputError } from '../tokens'
import { checkSource, frameSizeArgs } from './args'
import type { DesignToolsDeps } from './deps'

type FrameHandlers = Pick<
  Record<DesignToolName, ToolHandler>,
  'design_write_frame' | 'design_edit_frame' | 'design_draw' | 'design_frame'
>

const FRAME_ACTIONS = '"action" must be move, resize, rename, duplicate, delete, set_theme or reorder'

function frameEdits(a: ToolArgs): Array<{ oldText: string; newText: string }> {
  if (!Array.isArray(a.edits) || a.edits.length === 0)
    throw new DesignInputError('"edits" must be a list of {old_text, new_text}')
  return a.edits.map((item, i) => {
    const e = (item && typeof item === 'object' ? item : {}) as ToolArgs
    if (typeof e.old_text !== 'string' || typeof e.new_text !== 'string')
      throw new DesignInputError(`edits[${i}] needs old_text and new_text`)
    return { oldText: e.old_text, newText: e.new_text }
  })
}

/** Frames: write, edit, draw, and the `design_frame` actions. */
export function frameHandlers({ designs }: DesignToolsDeps): FrameHandlers {
  return {
    design_write_frame: async (ctx, a) => {
      const call = designs.frames.draftCall(ctx, textArg(a, 'name'))
      try {
        const design = designs.resolve(ctx, textArg(a, 'design'), true)
        call.designId = design.id
        const name = textArg(a, 'name', 80)
        if (!name) throw new DesignInputError('"name" is required')
        const size = frameSizeArgs(a)
        const html = a.html
        if (typeof html !== 'string') throw new DesignInputError('"html" is required')
        const css = rawTextArg(a, 'css')
        checkSource(html, css)
        const theme = resolveTheme(design, textArg(a, 'theme'))
        const written = await designs.frames.write(
          ctx,
          design,
          {
            name,
            size,
            html,
            css,
            frame: textArg(a, 'frame'),
            theme,
            keepTheme: a.theme === undefined,
            x: optionalIntLike(a, 'x'),
            y: optionalIntLike(a, 'y'),
          },
          call,
        )
        const { saved } = written
        return toolText(
          `${written.replaced ? 'Replaced' : 'Added'} the frame "${name}" (${saved.id}) ${frameSize(saved)} at (${saved.x}, ${saved.y})${written.moved}.\n${written.check}`,
          false,
          { detail: name },
        )
      } finally {
        call.finish()
      }
    },

    design_edit_frame: async (ctx, a) => {
      const design = designs.resolve(ctx, textArg(a, 'design'), true)
      const frame = designs.resolveFrame(design, textArg(a, 'frame'))
      if (frame.art_status) throw new DesignInputError(artOnly(frame))
      const edits = frameEdits(a)
      const check = await designs.frames.edit(ctx, design, frame, edits, checkSource)
      return toolText(
        `Edited "${frame.name}" (${edits.length} change${edits.length === 1 ? '' : 's'}).\n${check}`,
        false,
        {
          detail: frame.name,
        },
      )
    },

    design_draw: async (ctx, a) => {
      if (!designs.frames.canDraw) throw new DesignInputError('drawing is not available in this workspace')
      const design = designs.resolve(ctx, textArg(a, 'design'), true)
      const name = textArg(a, 'name', 80)
      if (!name) throw new DesignInputError('"name" is required')
      const prompt = textArg(a, 'prompt')
      const { prompt: promptLimits, side } = DESIGN_ART_LIMITS
      if (prompt.length < promptLimits.min || prompt.length > promptLimits.max)
        throw new DesignInputError(
          `"prompt" must be ${promptLimits.min} to ${promptLimits.max} characters: subject, composition, style and hex colors`,
        )
      const width = optionalIntLike(a, 'width')
      const height = optionalIntLike(a, 'height')
      if (width === null || height === null || [width, height].some((v) => v < side.min || v > side.max))
        throw new DesignInputError(`"width" and "height" must be ${side.min} to ${side.max} pixels`)
      const { saved, redrawn } = await designs.frames.draw(ctx, design, {
        name,
        prompt,
        size: { width, height },
        x: optionalIntLike(a, 'x'),
        y: optionalIntLike(a, 'y'),
      })
      return toolText(
        `Started drawing "${name}" (${saved.id}) ${width}×${height} at (${saved.x}, ${saved.y}) in the background; ` +
          `it takes a few minutes${redrawn ? ', starting from its current drawing' : ''}.\n` +
          `Keep designing. Place it in other frames now with <img data-art="${name}" alt="…" class="h-10 w-auto">: ` +
          'a placeholder of its shape shows until it is ready, and the user watches it being drawn. Never wait for it ' +
          '(no sleep, no screenshots): keep designing, or end your reply saying it is still being drawn. A later ' +
          'design tool result says when it is done; design_read lists its state.',
        false,
        { detail: name },
      )
    },

    design_frame: async (ctx, a) => {
      const design = designs.resolve(ctx, textArg(a, 'design'), true)
      const frame = designs.resolveFrame(design, textArg(a, 'frame'))
      const done = (message: string) => toolText(message, false, { detail: frame.name })
      switch (textArg(a, 'action')) {
        case 'move': {
          const x = optionalIntLike(a, 'x') ?? frame.x
          const y = optionalIntLike(a, 'y') ?? frame.y
          const outcome = designs.frames.move(ctx, design, frame, x, y)
          if (!outcome.moved)
            return toolText(
              `Not moved: (${x}, ${y}) overlaps "${outcome.overlaps}". The nearest free spot is (${outcome.free.x}, ${outcome.free.y}).`,
              true,
            )
          return done(`Moved "${frame.name}" to (${x}, ${y}).`)
        }
        case 'resize': {
          const size = frameSizeArgs({
            width: a.width ?? frame.width,
            height: a.height === undefined ? frame.height : a.height,
          })
          const { saved, spot, check } = await designs.frames.resize(ctx, design, frame, size)
          const moved =
            spot.x !== frame.x || spot.y !== frame.y
              ? ` and moved to (${spot.x}, ${spot.y}) to stay clear of other frames`
              : ''
          return done(`Resized "${frame.name}" to ${frameSize(saved)}${moved}.\n${check}`)
        }
        case 'rename': {
          const name = textArg(a, 'name', 80)
          if (!name) throw new DesignInputError('"name" is required')
          const moved = designs.frames.rename(ctx, design, frame, name)
          return toolText(
            `Renamed "${frame.name}" to "${name}".${moved ? ` Updated data-art in ${moved} frame${moved === 1 ? '' : 's'}.` : ''}`,
            false,
            { detail: name },
          )
        }
        case 'duplicate': {
          const copy = designs.frames.duplicate(ctx, design, frame, textArg(a, 'name'))
          return done(`Duplicated "${frame.name}" as "${copy.name}" (${copy.id}) at (${copy.x}, ${copy.y}).`)
        }
        case 'delete':
          designs.frames.remove(ctx, design, frame)
          return done(`Deleted "${frame.name}".`)
        case 'set_theme': {
          const theme = resolveTheme(design, textArg(a, 'theme'))
          designs.frames.setTheme(ctx, design, frame, theme)
          return done(`"${frame.name}" now uses the theme ${theme ?? lookOf(design).themes[0]}.`)
        }
        case 'reorder': {
          const position = optionalIntLike(a, 'position')
          if (position === null || position < 0) throw new DesignInputError('"position" must be 0 or more')
          return done(`Order now: ${designs.frames.reorder(ctx, design, frame, position).join(', ')}.`)
        }
        default:
          throw new DesignInputError(FRAME_ACTIONS)
      }
    },
  }
}
