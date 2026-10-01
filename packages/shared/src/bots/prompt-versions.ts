import { z } from 'zod'

import { AuthorType } from '../core/schemas'
import { endpoint } from '../http/endpoint'
import { Language } from '../workspace/workspace'

/** One saved version of a bot's persona (the editable part of its system prompt). */
export const PromptVersion = z.object({
  id: z.string(),
  botId: z.string(),
  text: z.string(),
  /** `system`: the persona a bot had before its first versioned change. */
  authorType: AuthorType,
  authorBotId: z.string().nullable(),
  reason: z.string().nullable(),
  /** `lineDiff` against the previous version. */
  diff: z.string(),
  added: z.number().int(),
  removed: z.number().int(),
  current: z.boolean(),
  createdAt: z.number().int(),
})
export type PromptVersion = z.infer<typeof PromptVersion>

/** A bot's persona change is applied right away (with a chat card) or proposed for approval. */
export const PromptUpdateMode = z.enum(['auto', 'approval'])
export type PromptUpdateMode = z.infer<typeof PromptUpdateMode>

/** A description becomes a full persona, reviewed before the bot is created. */
export const GenerateBotPromptBody = z.object({
  name: z.string().trim().max(48),
  label: z.string().trim().max(32),
  description: z.string().trim().min(1).max(8_000),
  language: Language,
})
export type GenerateBotPromptBody = z.input<typeof GenerateBotPromptBody>

export const BotPromptDraft = z.object({
  systemPrompt: z.string(),
  /** `estimateTokens`, like the persona cap. */
  tokens: z.number().int(),
  maxTokens: z.number().int(),
})
export type BotPromptDraft = z.infer<typeof BotPromptDraft>

export const promptVersionEndpoints = {
  /** Newest first. */
  listPromptVersions: endpoint({
    method: 'GET',
    path: '/w/:workspaceId/bots/:botId/prompt-versions',
    response: z.array(PromptVersion),
  }),
  /** Saved as a new version by the user. */
  restorePromptVersion: endpoint({
    method: 'POST',
    path: '/w/:workspaceId/bots/:botId/prompt-versions/:versionId/restore',
    response: PromptVersion,
  }),
  /** Brings back the version before this one. */
  undoPromptVersion: endpoint({
    method: 'POST',
    path: '/w/:workspaceId/prompt-versions/:versionId/undo',
    response: PromptVersion,
  }),
  generateBotPrompt: endpoint({
    method: 'POST',
    path: '/w/:workspaceId/bot-prompts/generate',
    body: GenerateBotPromptBody,
    response: BotPromptDraft,
  }),
}
