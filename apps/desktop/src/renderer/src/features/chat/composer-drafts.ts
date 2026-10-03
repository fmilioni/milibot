import { create } from 'zustand'

import { readPref, removePref, writePref } from '@/lib/prefs'

/** Storage key of one conversation's unsent text (ids are per workspace, so both are in the key). */
export const composerDraftKey = (workspaceId: string, conversationId: string) =>
  `milibot.composerDraft.${workspaceId}.${conversationId}`

interface ComposerDraftsState {
  /** Drafts read or typed in this window, by storage key; '' = none. */
  byKey: Record<string, string>
  setDraft(workspaceId: string, conversationId: string, text: string): void
}

/**
 * The composer's unsent text per conversation, kept in this window's storage so it survives the
 * composer unmounting (another screen) and the app restarting. Cleared by setting ''.
 */
export const useComposerDrafts = create<ComposerDraftsState>()((set) => ({
  byKey: {},
  setDraft(workspaceId, conversationId, text) {
    const key = composerDraftKey(workspaceId, conversationId)
    if (text) writePref(key, text)
    else removePref(key)
    set((s) => ({ byKey: { ...s.byKey, [key]: text } }))
  },
}))

/** A conversation's draft and its setter; falls back to storage until this window touches it. */
export function useComposerDraft(workspaceId: string, conversationId: string) {
  const key = composerDraftKey(workspaceId, conversationId)
  const cached = useComposerDrafts((s) => s.byKey[key])
  const setDraft = useComposerDrafts((s) => s.setDraft)
  const value = cached ?? readPref(key) ?? ''
  return [value, (text: string) => setDraft(workspaceId, conversationId, text)] as const
}
