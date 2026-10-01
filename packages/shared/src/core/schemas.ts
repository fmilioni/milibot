import { z } from 'zod'

export const AuthorType = z.enum(['user', 'bot', 'system'])
export type AuthorType = z.infer<typeof AuthorType>

/** Authors of what people and bots write (comments, files, revisions): never `system`. */
export const UserOrBot = AuthorType.exclude(['system'])
export type UserOrBot = z.infer<typeof UserOrBot>

/** Steps (or items) done out of all. */
export const Progress = z.object({ done: z.number().int(), total: z.number().int() })
export type Progress = z.infer<typeof Progress>
