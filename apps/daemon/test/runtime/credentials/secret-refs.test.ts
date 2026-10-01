import { describe, expect, it } from 'vitest'

import {
  resolveSecretRefs,
  SecretRefError,
  secretRefNames,
} from '../../../src/runtime/credentials/secret-refs'

const secrets: Record<string, string> = { BANK_PASSWORD: 'hunter2$&', PIN: '1234' }
const lookup = (name: string) => secrets[name]

describe('secret references', () => {
  it('replaces every reference with its value, leaving the rest of the text as is', () => {
    expect(resolveSecretRefs('{{secret:BANK_PASSWORD}}', lookup)).toBe('hunter2$&')
    expect(resolveSecretRefs('pin {{secret:PIN}} e {{secret:PIN}}!', lookup)).toBe('pin 1234 e 1234!')
    expect(resolveSecretRefs('texto comum {{secret:}} {secret:PIN}', lookup)).toBe(
      'texto comum {{secret:}} {secret:PIN}',
    )
  })

  it('refuses unknown names before replacing anything', () => {
    expect(() => resolveSecretRefs('{{secret:PIN}} {{secret:NOPE}}', lookup)).toThrow(SecretRefError)
    expect(() => resolveSecretRefs('{{secret:NOPE}}', lookup)).toThrow(/NOPE.*list_secrets/)
  })

  it('lists the names referenced', () => {
    expect(secretRefNames('{{secret:A}} {{secret:B}} {{secret:A}}')).toEqual(['A', 'B'])
  })
})
