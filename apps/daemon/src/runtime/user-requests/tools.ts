import type { ToolExecContext, ToolResult } from '@milibot/agent'
import {
  flagArg,
  textArg,
  type ToolArgs,
  ToolInputError,
  toolText,
  trimmedString,
} from '@milibot/agent/tools'
import { type Bot, secretRef, UserQuestion } from '@milibot/shared'
import { z } from 'zod'

import type { CredentialService } from '../credentials'
import { ToolSwitch } from '../tools-core'
import type { UserRequestService } from './service'
import { kindText, questionOutcomeText, secretOutcomeText, secretUsageText, timeoutText } from './texts'

const SECRET_NAME = /^[A-Z][A-Z0-9_]{0,63}$/

export interface UserRequestToolsDeps {
  requests: Pick<UserRequestService, 'askQuestions' | 'askSecret' | 'timeoutSeconds'>
  credentials: Pick<CredentialService, 'checkSecretName' | 'secretsFor' | 'findSecret'>
}

function parseQuestions(a: ToolArgs): UserQuestion[] {
  if (!Array.isArray(a.questions) || a.questions.length === 0)
    throw new ToolInputError('"questions" must be a list of 1 to 4 questions')
  const questions = a.questions.map((raw, i) => {
    const q = (raw && typeof raw === 'object' ? raw : {}) as ToolArgs
    const multiSelect = flagArg(q, 'multi_select') === true || flagArg(q, 'multiSelect') === true
    let recommendedSeen = false
    const options = (Array.isArray(q.options) ? q.options : []).map((rawOption) => {
      const o = (rawOption && typeof rawOption === 'object' ? rawOption : {}) as ToolArgs
      const description = textArg(o, 'description')
      // Single choice: only the first recommended option counts.
      const recommended = flagArg(o, 'recommended') === true && (multiSelect || !recommendedSeen)
      if (recommended) recommendedSeen = true
      return {
        label: textArg(o, 'label'),
        ...(description ? { description: description.slice(0, 200) } : {}),
        ...(recommended ? { recommended: true } : {}),
      }
    })
    const labels = options.map((o) => o.label.toLowerCase())
    if (new Set(labels).size !== labels.length)
      throw new ToolInputError(`questions[${i}]: option labels must be different`)
    return {
      header: textArg(q, 'header', 16) || `${i + 1}`,
      question: trimmedString(q.question),
      options,
      multiSelect,
    }
  })
  const parsed = z.array(UserQuestion).min(1).max(4).safeParse(questions)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    throw new ToolInputError(
      `${issue?.path.join('.') || 'questions'}: ${issue?.message ?? 'invalid'} (1–4 questions, 2–4 options each, labels up to 80 characters)`,
    )
  }
  return parsed.data
}

/** `ask_user`, `request_secret` and `list_secrets`. */
export class UserRequestTools extends ToolSwitch {
  readonly name = 'user requests'
  protected readonly handlers = {
    ask_user: (ctx: ToolExecContext, a: ToolArgs) => this.askUser(ctx, a),
    request_secret: (ctx: ToolExecContext, a: ToolArgs) => this.requestSecret(ctx, a),
    list_secrets: (ctx: ToolExecContext) => this.listSecrets(ctx.bot),
  }

  constructor(private readonly deps: UserRequestToolsDeps) {
    super()
  }

  private async askUser(ctx: ToolExecContext, a: ToolArgs): Promise<ToolResult> {
    const questions = parseQuestions(a)
    const outcome = await this.deps.requests.askQuestions(ctx, questions)
    if (outcome === 'timeout') return toolText(timeoutText('question', this.deps.requests.timeoutSeconds()))
    return toolText(questionOutcomeText(questions, outcome))
  }

  private async requestSecret(ctx: ToolExecContext, a: ToolArgs): Promise<ToolResult> {
    const { credentials } = this.deps
    const name = textArg(a, 'name')
    if (!SECRET_NAME.test(name))
      throw new ToolInputError('"name" must be UPPER_SNAKE_CASE (letters, digits and _), e.g. BANK_PASSWORD')
    credentials.checkSecretName(name)
    const label = (textArg(a, 'label') || name).slice(0, 120)
    const reason = textArg(a, 'reason', 500)
    const asEnv = flagArg(a, 'as_env') === true
    const replace = flagArg(a, 'replace') === true
    const mine = credentials.secretsFor(ctx.bot).find((s) => s.name === name)
    if (mine && !replace) {
      const envNote =
        asEnv && mine.kind !== 'env'
          ? ' It is not an environment variable; to have it as one, call request_secret again with replace: true and as_env: true.'
          : ''
      return toolText(
        `You already have ${name} (${kindText(mine)}).${envNote} ${secretUsageText(name, mine.kind === 'env')}`,
      )
    }
    if (!mine && credentials.findSecret(name))
      return toolText(
        `A secret named ${name} already exists but is not available to you; use another name.`,
        true,
      )
    const params = { name, label, reason, asEnv, replace }
    const outcome = await this.deps.requests.askSecret(ctx, params)
    if (outcome === 'timeout') return toolText(timeoutText('secret', this.deps.requests.timeoutSeconds()))
    return toolText(secretOutcomeText(params, outcome))
  }

  private listSecrets(bot: Bot): ToolResult {
    const secrets = this.deps.credentials.secretsFor(bot)
    if (secrets.length === 0)
      return toolText('You have no secrets. Ask the user for one with request_secret when a task needs it.')
    const lines = secrets.map((s) => `- ${s.name}${s.label ? ` — ${s.label}` : ''} (${kindText(s)})`)
    return toolText(
      `Secrets you can use (values are never shown):\n${lines.join('\n')}\n\n` +
        `Type ${secretRef('NAME')} with browser_type or computer (action "type"); in a shell read ` +
        '"$(cat "$MILIBOT_SECRETS_DIR/NAME")".',
    )
  }
}
