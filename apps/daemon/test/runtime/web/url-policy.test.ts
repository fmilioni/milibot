import { describe, expect, it } from 'vitest'

import { isBlockedAddress, normalizeWebUrl } from '../../../src/runtime/web/url-policy'

describe('normalizeWebUrl', () => {
  it('adds https to bare domains and upgrades http, keeping a way back to http', () => {
    expect(normalizeWebUrl('nodejs.org/api/net.html#blocklist')).toEqual({
      url: new URL('https://nodejs.org/api/net.html'),
      httpFallback: false,
    })
    expect(normalizeWebUrl('http://example.com/a').url.href).toBe('https://example.com/a')
    expect(normalizeWebUrl('http://example.com/a').httpFallback).toBe(true)
    expect(normalizeWebUrl('example.com:8443/x').url.href).toBe('https://example.com:8443/x')
  })

  it('refuses local and private addresses, other schemes and credentials', () => {
    for (const url of [
      'http://localhost:3000',
      'localhost',
      'http://printer.local/',
      'http://10.0.2.2:4000/mcp',
      'http://127.0.0.1/',
      'http://[::1]/',
      'http://[::ffff:127.0.0.1]/',
      'http://2130706433/',
      'http://0x7f.1/',
      'http://192.168.0.10/',
      'http://intranet/',
      'file:///etc/passwd',
      'ftp://example.com/',
      'https://user:pass@example.com/',
    ])
      expect(() => normalizeWebUrl(url), url).toThrow()
  })

  it('checks addresses against the private ranges', () => {
    expect(isBlockedAddress('10.0.2.2')).toBe(true)
    expect(isBlockedAddress('172.20.1.1')).toBe(true)
    expect(isBlockedAddress('169.254.169.254')).toBe(true)
    expect(isBlockedAddress('fd00::1')).toBe(true)
    expect(isBlockedAddress('::ffff:192.168.1.1')).toBe(true)
    expect(isBlockedAddress('93.184.216.34')).toBe(false)
    expect(isBlockedAddress('2606:4700::1111')).toBe(false)
    expect(isBlockedAddress('not an ip')).toBe(true)
  })
})
