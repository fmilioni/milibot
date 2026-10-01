import { z } from 'zod'

/*
 * Requests a bot makes to the user and waits for: `ask_user` (`question` card) and `request_secret`
 * (`secret_request` card). The secret value goes from the card straight to the daemon; it never reaches
 * messages, the model or the logs.
 */

export const QuestionOption = z.object({
  label: z.string().min(1).max(80),
  description: z.string().max(200).optional(),
  recommended: z.boolean().optional(),
})
export type QuestionOption = z.infer<typeof QuestionOption>

export const UserQuestion = z.object({
  /** Short chip above the question (the tab label when there are several). */
  header: z.string().min(1).max(16),
  question: z.string().min(1).max(500),
  options: z.array(QuestionOption).min(2).max(4),
  multiSelect: z.boolean().default(false),
})
export type UserQuestion = z.infer<typeof UserQuestion>

export const QuestionAnswer = z.object({
  selected: z.array(z.string()).max(4),
  /** Free answer instead of (or besides) the options. */
  other: z.string().max(2000).optional(),
})
export type QuestionAnswer = z.infer<typeof QuestionAnswer>

export const AnswerQuestionBody = z.object({ answers: z.array(QuestionAnswer).min(1).max(4) })
export type AnswerQuestionBody = z.input<typeof AnswerQuestionBody>

/** Who can use a remembered secret: the bot that asked or every bot. */
export const SecretScope = z.enum(['bot', 'all'])
export type SecretScope = z.infer<typeof SecretScope>

export const AnswerSecretBody = z.object({
  value: z.string().min(1).max(32_000),
  /** true = the secret store (listed with the credentials); false = runtime memory only. */
  remember: z.boolean(),
  scope: SecretScope,
})
export type AnswerSecretBody = z.input<typeof AnswerSecretBody>

export const DEFAULT_USER_REQUEST_TIMEOUT_SECONDS = 600

/** Name of a secret (environment variable name rules). */
export const ENV_SECRET_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/

/** `{{secret:NAME}}`; group 1 = NAME. */
const SECRET_REF_PATTERN = `\\{\\{secret:(${ENV_SECRET_NAME_PATTERN.source.slice(1, -1)})\\}\\}`

/** A fresh global regex (it is stateful with `g`, so never share one instance). */
export function secretRefRegex(): RegExp {
  return new RegExp(SECRET_REF_PATTERN, 'g')
}

export function secretRef(name: string): string {
  return `{{secret:${name}}}`
}
