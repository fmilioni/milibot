import type { ToolExecContext } from '@milibot/agent'

import { DaemonError } from '../../errors'
import { resolveByRef } from '../tools-core'
import { type DesignRow, type DesignStore, type FrameRow, lookOf } from './store'
import { DesignInputError, findTheme } from './tokens'

type RefContext = Pick<ToolExecContext, 'bot' | 'conversationId'>

/**
 * A design by id or name: in this chat first, then the bot's own, then any. Archived designs match only by
 * id or exact name, and `write` refuses them.
 */
export function resolveDesign(store: DesignStore, ctx: RefContext, ref: string, write = false): DesignRow {
  if (!ref) throw new DesignInputError('"design" is required (its name or id)')
  const match = resolveByRef(store.rows({ archived: true }), ref, {
    id: (r) => r.id,
    names: (r) => [r.name],
    partialAllowed: (r) => r.archived_at === null,
    prefer: [(r) => r.conversation_id === ctx.conversationId, (r) => r.bot_id === ctx.bot.id],
    ambiguous: { exact: 'first', partial: 'first' },
  })
  if (!('found' in match))
    throw new DaemonError('not_found', `There is no design "${ref}" (design_list lists them).`)
  const row = match.found
  if (write && row.archived_at !== null)
    throw new DesignInputError(`"${row.name}" is archived; unarchive it with design_archive first`)
  return row
}

/** A frame by id or name; a partial name only when it matches one frame. */
export function findFrame(store: DesignStore, design: DesignRow, ref: string): FrameRow | null {
  if (!ref) return null
  const match = resolveByRef(store.frames(design.id), ref, {
    id: (f) => f.id,
    names: (f) => [f.name],
    ambiguous: { exact: 'first', partial: 'report' },
  })
  return 'found' in match ? match.found : null
}

export function resolveFrame(store: DesignStore, design: DesignRow, ref: string): FrameRow {
  if (!ref) throw new DesignInputError('"frame" is required (its name or id)')
  const frame = findFrame(store, design, ref)
  if (!frame) {
    const names = store.frames(design.id).map((f) => `"${f.name}"`)
    throw new DaemonError(
      'not_found',
      `There is no frame "${ref}" in "${design.name}"${names.length ? ` (frames: ${names.join(', ')})` : ' (it has no frames yet)'}.`,
    )
  }
  return frame
}

/** The design's theme a bot names; '' is none (the default). */
export function resolveTheme(design: DesignRow, name: string): string | null {
  if (!name) return null
  const themes = lookOf(design).themes
  const theme = findTheme(themes, name)
  if (!theme) throw new DesignInputError(`there is no theme "${name}" (themes: ${themes.join(', ')})`)
  return theme
}
