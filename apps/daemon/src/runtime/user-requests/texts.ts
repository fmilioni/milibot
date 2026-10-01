import { type QuestionAnswer, secretRef, type UserQuestion } from '@milibot/shared'

import type { BotSecret } from '../credentials'
import type { Resolution } from './service'
import type { RequestKind, SecretParams } from './store'

/** The recommended options of a question (at most one for single choice). */
function recommendedLabels(question: UserQuestion): string[] {
  return question.options.filter((o) => o.recommended).map((o) => o.label)
}

function answerText(answer: QuestionAnswer | undefined): string {
  const parts = [
    ...(answer?.selected ?? []),
    ...(answer?.other?.trim() ? [`"${answer.other.trim()}" (own answer)`] : []),
  ]
  return parts.join('; ') || '(no answer)'
}

/** What the bot reads: each question with the user's answer and whether it matches the recommendation. */
export function questionResultText(questions: UserQuestion[], answers: QuestionAnswer[]): string {
  const lines = questions.map((question, i) => {
    const answer = answers[i]
    const recommended = recommendedLabels(question)
    const chose = answer?.selected ?? []
    const verdict = !recommended.length
      ? ''
      : chose.length === recommended.length &&
          recommended.every((label) => chose.includes(label)) &&
          !answer?.other?.trim()
        ? ' — the option you recommended'
        : ` — not what you recommended (${recommended.join(', ')})`
    return `${i + 1}. ${question.question}\n   Answer: ${answerText(answer)}${verdict}`
  })
  return `The user answered:\n${lines.join('\n')}`
}

/** Card `content`: the questions (and the answers once given) as plain text, for previews and search. */
export function questionContent(questions: UserQuestion[], answers?: QuestionAnswer[] | null): string {
  return questions
    .map((question, i) =>
      answers
        ? `${question.question}\n→ ${answerText(answers[i])}`
        : `${question.question}\n${question.options.map((o) => `- ${o.label}`).join('\n')}`,
    )
    .join('\n\n')
}

export function secretUsageText(name: string, asEnv: boolean): string {
  return (
    `Use it only by reference: type ${secretRef(name)} with browser_type or computer (action "type"); ` +
    `in a shell read it with "$(cat "$MILIBOT_SECRETS_DIR/${name}")".` +
    (asEnv
      ? ` It is also the environment variable $${name} of your commands (in a shell started before now, read the file instead).`
      : '') +
    ' Never print, log, commit or save its value.'
  )
}

export function kindText(secret: BotSecret): string {
  if (secret.kind === 'env') return `environment variable $${secret.name}`
  return secret.kind === 'temporary' ? 'reference only, for a limited time' : 'reference only'
}

export function questionOutcomeText(questions: UserQuestion[], outcome: Resolution): string {
  if (outcome.status === 'answered') return questionResultText(questions, outcome.answers)
  if (outcome.status === 'answered_in_chat')
    return `The user did not pick an option; they answered in the chat instead:\n\n${outcome.text}`
  return 'The user dismissed the question without answering. Go on with your best judgment (say what you assumed) or ask in the chat.'
}

export function secretOutcomeText(params: SecretParams, outcome: Resolution): string {
  if (outcome.status !== 'provided')
    return `The user declined to provide ${params.name}. Do not ask for it again unless they bring it up; go on without it or say what is blocked.`
  const kept = params.asEnv
    ? 'saved in the workspace settings'
    : outcome.remember
      ? 'saved for later use'
      : 'kept only for now (it is forgotten within 12 hours)'
  return `The user provided ${params.name} (${params.label}), ${kept}. ${secretUsageText(params.name, params.asEnv)}`
}

export function timeoutText(kind: RequestKind, seconds: number): string {
  const what = kind === 'secret' ? 'provided the secret' : 'answered'
  return (
    `The user has not ${what} yet (waited ${seconds} s). The card stays open in the chat: when they answer ` +
    'you get a new turn with the answer. Go on with what does not depend on it, or end your turn saying what you are waiting for.'
  )
}
