import { z } from 'zod'

import { foldText } from '../core/text'
import { endpoint } from '../http/endpoint'
import { ConversationSummary, GroupSettings } from './conversations'

export const DEFAULT_GROUP_SETTINGS: GroupSettings = {
  respondWithoutMention: true,
  botsCanManageMembers: true,
  maxConsecutiveBotMessages: 6,
  confirmRemovals: true,
}

export function groupSettings(conversation: Pick<ConversationSummary, 'settings'>): GroupSettings {
  return { ...DEFAULT_GROUP_SETTINGS, ...conversation.settings }
}

export const UpdateGroupSettingsBody = GroupSettings.partial().extend({
  maxConsecutiveBotMessages: z.number().int().min(1).max(50).optional(),
})
export type UpdateGroupSettingsBody = z.input<typeof UpdateGroupSettingsBody>

export interface MentionCandidate {
  id: string
  name: string
  slug: string
}

const WORD_CHAR = /[\p{L}\p{N}_-]/u
// Portuguese on purpose: `@todos`/`@pessoal` are what pt-BR users type.
const EVERYONE = ['todos', 'all', 'everyone', 'pessoal']

/**
 * Ids of the candidates `@mentioned` in `text` (by name, case/accent-insensitive, or by slug).
 * Names may contain spaces; the longest match wins and must end at a word boundary. `@todos`/`@all`
 * mentions everyone.
 */
export function parseMentions(text: string, candidates: MentionCandidate[]): string[] {
  if (!text.includes('@') || candidates.length === 0) return []
  const folded = foldText(text)
  const keys = candidates
    .flatMap((c) => [
      { id: c.id, key: foldText(c.name) },
      { id: c.id, key: c.slug },
    ])
    .concat(EVERYONE.map((key) => ({ id: '*', key })))
    .filter((k) => k.key)
    .sort((a, b) => b.key.length - a.key.length)
  const found = new Set<string>()
  for (let i = folded.indexOf('@'); i >= 0; i = folded.indexOf('@', i + 1)) {
    if (i > 0 && WORD_CHAR.test(folded[i - 1] as string)) continue
    const rest = folded.slice(i + 1)
    const match = keys.find((k) => {
      if (!rest.startsWith(k.key)) return false
      const after = rest[k.key.length]
      return after === undefined || !WORD_CHAR.test(after)
    })
    if (!match) continue
    if (match.id === '*') return candidates.map((c) => c.id)
    found.add(match.id)
  }
  return candidates.filter((c) => found.has(c.id)).map((c) => c.id)
}

const CONVERSATION = '/w/:workspaceId/conversations/:conversationId'

export const groupEndpoints = {
  updateGroupSettings: endpoint({
    method: 'PATCH',
    path: `${CONVERSATION}/settings`,
    body: UpdateGroupSettingsBody,
    response: ConversationSummary,
  }),
  addGroupMember: endpoint({
    method: 'POST',
    path: `${CONVERSATION}/members`,
    body: z.object({ botId: z.string() }),
    response: ConversationSummary,
  }),
  removeGroupMember: endpoint({
    method: 'DELETE',
    path: `${CONVERSATION}/members/:botId`,
    response: ConversationSummary,
  }),
}
