import { mkdtempSync, utimesSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { tokenMatches, TokenSource } from '../src/auth.ts'

const TOKEN = 'a'.repeat(32)

describe('tokenMatches', () => {
  it('accepts the exact bearer token', () => {
    expect(tokenMatches(TOKEN, `Bearer ${TOKEN}`)).toBe(true)
    expect(tokenMatches(TOKEN, `bearer ${TOKEN}`)).toBe(true)
  })

  it('rejects missing, wrong or malformed headers', () => {
    expect(tokenMatches(TOKEN, undefined)).toBe(false)
    expect(tokenMatches(TOKEN, TOKEN)).toBe(false)
    expect(tokenMatches(TOKEN, `Bearer ${TOKEN}x`)).toBe(false)
    expect(tokenMatches(TOKEN, `Bearer ${'b'.repeat(32)}`)).toBe(false)
    expect(tokenMatches(TOKEN, 'Bearer ')).toBe(false)
    expect(tokenMatches(TOKEN, `Basic ${TOKEN}`)).toBe(false)
  })

  it('rejects everything when no token is configured', () => {
    expect(tokenMatches(null, 'Bearer anything')).toBe(false)
    expect(tokenMatches('', 'Bearer ')).toBe(false)
  })
})

describe('TokenSource', () => {
  it('returns null until the file exists and picks up changes', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'ga-auth-'))
    const file = path.join(dir, 'agent.token')
    const src = new TokenSource(file)
    expect(src.get()).toBeNull()
    writeFileSync(file, `${TOKEN}\n`)
    expect(src.get()).toBe(TOKEN)
    writeFileSync(file, 'b'.repeat(40))
    const later = new Date(Date.now() + 5000)
    utimesSync(file, later, later)
    expect(src.get()).toBe('b'.repeat(40))
  })

  it('ignores tokens that are too short', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'ga-auth-'))
    const file = path.join(dir, 'agent.token')
    writeFileSync(file, 'short')
    expect(new TokenSource(file).get()).toBeNull()
  })
})
