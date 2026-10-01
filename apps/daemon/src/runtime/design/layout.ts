import { type DesignProblem, isPagedSize, nearestFreeSpot } from '@milibot/shared'

import { errorMessage } from '../../errors'
import { stopped } from '../tools-core'
import { problemLines } from './format'
import type { DesignHost } from './host'
import type { RenderResult } from './render'
import { type DesignRow, type FrameRow, placedFrames } from './store'

const OUTLINE_LINES = 40
/** Less overflow than this is rounding. */
const GROW_MIN_OVERFLOW = 8

export interface LayoutCheck {
  text: string
  problems: DesignProblem[]
  rendered: RenderResult | null
}

/** Renders frames to check their layout: problems (compile + render) and a short outline. */
export class LayoutChecks {
  constructor(private readonly host: DesignHost) {}

  async check(
    design: DesignRow,
    frame: FrameRow,
    signal: AbortSignal | null,
    extra: DesignProblem[] = [],
  ): Promise<LayoutCheck> {
    const { host } = this
    const compiled = await host.compileRow(design, frame)
    let rendered: RenderResult | null = null
    let note = ''
    try {
      rendered = await host.render.render({
        url: await host.frameUrl(design.id, frame.id, null),
        width: frame.width,
        height: frame.height,
        scale: 1,
        screenshot: false,
      })
      if (frame.height === null && rendered.height !== frame.measured_height) {
        host.store.setMeasuredHeight(frame.id, rendered.height)
        host.emitFrame(design.id, host.store.frame(frame.id) as FrameRow)
      }
    } catch (err) {
      if (signal?.aborted) throw stopped()
      note = `Layout check unavailable (${errorMessage(err)}); design_screenshot can check it later.`
    }
    const problems = [...extra, ...compiled.problems, ...(rendered?.problems ?? [])]
    const lines = [note || problemLines(problems)]
    if (note && problems.length) lines.push(problemLines(problems))
    if (rendered) {
      if (frame.height === null) lines.push(`Content height: ${rendered.height}px.`)
      const outline = rendered.outline
      if (outline.length)
        lines.push(
          `Outline (tag #id or @n, "text", (x,y w×h)):\n${outline.slice(0, OUTLINE_LINES).join('\n')}${outline.length > OUTLINE_LINES ? `\n… ${outline.length - OUTLINE_LINES} more (design_read with frame shows the whole outline)` : ''}`,
        )
    }
    return { text: lines.join('\n'), problems, rendered }
  }

  /**
   * The check after a write: a screen whose content runs past its fixed height grows instead (moved clear of
   * other frames, its saved revision amended); slides and pages keep their size.
   */
  async checkWritten(
    design: DesignRow,
    saved: FrameRow,
    signal: AbortSignal,
    extra: DesignProblem[],
  ): Promise<string> {
    const { store } = this.host
    const check = await this.check(design, saved, signal, extra)
    const content = check.rendered?.contentHeight
    if (
      saved.height === null ||
      content === undefined ||
      content <= saved.height + GROW_MIN_OVERFLOW ||
      isPagedSize(saved.width, saved.height)
    )
      return check.text
    const others = placedFrames(store.frames(design.id)).filter((f) => f.id !== saved.id)
    const spot = nearestFreeSpot({ x: saved.x, y: saved.y, width: saved.width, height: content }, others)
    const grown = store.putFrame({ ...saved, ...spot, height: null, measured_height: content })
    store.amendFrameRevision(design.id, grown)
    this.host.emitFrame(design.id, grown)
    const again = await this.check(design, grown, signal, extra)
    return (
      `The content (${content}px) is taller than the ${saved.height}px given, so the frame now grows with it` +
      `${spot.x !== saved.x || spot.y !== saved.y ? ` and moved to (${spot.x}, ${spot.y}) to stay clear of other frames` : ''}` +
      ' (for a fixed height, make the content fit or scroll inside an overflow-auto area).\n' +
      again.text
    )
  }
}
