import { z } from 'zod'

import { foldText } from '../core/text'
import { ModelTuning, ReasoningEffort } from '../models/reasoning'
import { Avatar } from './avatar'

/** `effort` is transient (struggling: retries, errors); it is persisted as `working`. */
export const BotStatus = z.enum(['idle', 'thinking', 'working', 'talking', 'paused', 'effort'])
export type BotStatus = z.infer<typeof BotStatus>

export const Bot = z.object({
  id: z.string(),
  name: z.string().min(1).max(48),
  slug: z.string(),
  label: z.string().max(32),
  systemPrompt: z.string(),
  providerId: z.string().nullable(),
  model: z.string().nullable(),
  effort: ReasoningEffort.nullable(),
  contextLimit: z.number().int().positive().nullable(),
  maxOutputTokens: z.number().int().positive().nullable(),
  avatar: Avatar,
  linuxUid: z.number().int(),
  displayNum: z.number().int(),
  status: BotStatus,
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
})
export type Bot = z.infer<typeof Bot>

/** Which bots something applies to: every bot, or the listed bot ids. */
export const BotScope = z.union([z.literal('all'), z.array(z.string()).max(500)])
export type BotScope = z.infer<typeof BotScope>

/**
 * The bot a model or a person names: its id, slug or name (case- and accent-insensitive, `@` optional),
 * else the first whose name starts with it (3+ characters).
 */
export function findBotByRef<B extends Pick<Bot, 'id' | 'slug' | 'name'>>(
  bots: readonly B[],
  ref: string,
): B | null {
  const key = foldText(ref.replace(/^@/, ''), { trim: true })
  const name = (b: B) => foldText(b.name, { trim: true })
  return (
    bots.find((b) => b.id === ref || b.slug === key || name(b) === key) ??
    bots.find((b) => key.length >= 3 && name(b).startsWith(key)) ??
    null
  )
}

export const CreateBotBody = z.object({
  name: z.string().trim().min(1).max(48),
  label: z.string().trim().max(32).default(''),
  systemPrompt: z.string().default(''),
  providerId: z.string().nullable().optional(),
  model: z.string().nullable().optional(),
  ...ModelTuning.shape,
  avatar: Avatar.optional(),
})
export type CreateBotBody = z.input<typeof CreateBotBody>

export const UpdateBotBody = z.object({
  name: z.string().trim().min(1).max(48).optional(),
  label: z.string().trim().max(32).optional(),
  systemPrompt: z.string().optional(),
  providerId: z.string().nullable().optional(),
  model: z.string().nullable().optional(),
  ...ModelTuning.shape,
  avatar: Avatar.optional(),
})
export type UpdateBotBody = z.input<typeof UpdateBotBody>
