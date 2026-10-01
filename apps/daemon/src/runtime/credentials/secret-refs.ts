import { secretRefRegex } from '@milibot/shared'

import { DaemonError } from '../../errors'

/** A `{{secret:NAME}}` the bot cannot use: nothing is typed. */
export class SecretRefError extends DaemonError {
  constructor(message: string) {
    super('validation_failed', message)
    this.name = 'SecretRefError'
  }
}

export function secretRefNames(text: string): string[] {
  return [...new Set([...text.matchAll(secretRefRegex())].map((m) => m[1] as string))]
}

/**
 * Replaces every `{{secret:NAME}}` of `text` with the value `lookup` gives. Any unknown name throws before
 * anything is replaced, with a message the bot can act on.
 */
export function resolveSecretRefs(text: string, lookup: (name: string) => string | undefined): string {
  const names = secretRefNames(text)
  if (names.length === 0) return text
  const missing = names.filter((name) => lookup(name) === undefined)
  if (missing.length)
    throw new SecretRefError(
      `Nothing was typed: ${missing.map((n) => `{{secret:${n}}}`).join(', ')} ${missing.length > 1 ? 'are' : 'is'} not available to you. ` +
        'Check the names with list_secrets, or ask the user for it with request_secret.',
    )
  return text.replace(secretRefRegex(), (_, name: string) => lookup(name) as string)
}
