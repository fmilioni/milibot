/**
 * Bot screens the user took over from this window (`screenKey`). Once the window's VM panel stops showing
 * one, it goes back to its bot (see `effects.ts`); a screen left under the user's control keeps the bot
 * paused.
 */
export const takenOverHere = new Set<string>()
