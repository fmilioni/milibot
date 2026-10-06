import { describe, expect, it } from 'vitest'

import { invokes } from './contract'
import { isWebUrl } from './web-url'

describe('isWebUrl', () => {
  it('accepts http(s) in any case', () => {
    expect(isWebUrl('https://a.example.com/x')).toBe(true)
    expect(isWebUrl('HTTP://a.example.com')).toBe(true)
  })

  it('refuses other schemes and non-URLs', () => {
    for (const url of [
      'file:///etc/passwd',
      'smb://host/share',
      'javascript:alert(1)',
      'data:text/html,x',
      '',
      'example.com',
    ])
      expect(isWebUrl(url)).toBe(false)
  })

  it('is the rule of the openExternal channel', () => {
    expect(invokes.openExternal.args.safeParse(['https://a.example.com']).success).toBe(true)
    expect(invokes.openExternal.args.safeParse(['file:///etc/passwd']).success).toBe(false)
  })
})
