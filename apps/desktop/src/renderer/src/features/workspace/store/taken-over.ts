import type { WorkspaceEvent } from '@milibot/shared'

import { screenKey } from '@/features/vm/lib/screen-control'

/**
 * Bot screens the user took over from this window (`screenKey`). Once the window's VM panel stops showing
 * one, it goes back to its bot (see `effects.ts`); a screen left under the user's control keeps the bot
 * paused.
 */
export const takenOverHere = new Set<string>()

/** A screen given back anywhere (the VM window, its close, another window) is no longer this window's to give back. */
export function applyScreenEvent(workspaceId: string, event: WorkspaceEvent): void {
  if (event.type !== 'bot.screen' || event.payload.control === 'user') return
  takenOverHere.delete(screenKey({ workspaceId, botId: event.payload.botId }))
}
