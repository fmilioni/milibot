import { describe, expect, it } from 'vitest'

import {
  commitIdentity,
  githubSetupRequest,
  parseGithubExpiration,
} from '../../../src/runtime/credentials/github'
import { GITHUB_SETUP_SCRIPT } from '../../../src/runtime/credentials/scripts/github-setup.generated'

const TOKEN = 'github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz'

describe('GitHub setup in the VM', () => {
  it('passes the token only through stdin', () => {
    const request = githubSetupRequest({
      user: 'bot-ana',
      token: TOKEN,
      touchLogin: true,
      identity: { name: 'Ana (Milibot)', email: 'ana@milibot.local' },
    })
    expect(request.stdin).toBe(`${TOKEN}\n`)
    const { stdin: _stdin, ...rest } = request
    expect(JSON.stringify(rest)).not.toContain(TOKEN)
    expect(request.cmd).toBe(GITHUB_SETUP_SCRIPT)
    expect(request.env).toMatchObject({
      MILIBOT_GH: 'login',
      GIT_NAME: 'Ana (Milibot)',
      GIT_EMAIL: 'ana@milibot.local',
    })
    expect(GITHUB_SETUP_SCRIPT).toContain(
      'gh auth login --hostname github.com --git-protocol https --with-token',
    )
    expect(GITHUB_SETUP_SCRIPT).toContain('gh auth setup-git')
    expect(GITHUB_SETUP_SCRIPT).toContain('url.https://github.com/.insteadOf git@github.com:')
  })

  it('logs out without a token and leaves the login alone on identity-only syncs', () => {
    const logout = githubSetupRequest({ user: 'agent', token: null, touchLogin: true, identity: null })
    expect(logout.env?.MILIBOT_GH).toBe('logout')
    expect(logout.stdin).toBeUndefined()
    const keep = githubSetupRequest({ user: 'agent', token: TOKEN, touchLogin: false, identity: null })
    expect(keep.env?.MILIBOT_GH).toBe('keep')
    expect(keep.stdin).toBeUndefined()
  })

  it('parses the token expiration header', () => {
    expect(parseGithubExpiration('2026-12-01 00:00:00 UTC')).toBe(Date.UTC(2026, 11, 1))
    expect(parseGithubExpiration('2026-12-01 10:30:00 -0300')).toBe(Date.UTC(2026, 11, 1, 13, 30))
    expect(parseGithubExpiration(null)).toBeNull()
    expect(parseGithubExpiration('soon')).toBeNull()
  })

  it('fills commit identity templates', () => {
    expect(commitIdentity('{bot} (Milibot)', { name: 'Dex', slug: 'dex' })).toBe('Dex (Milibot)')
    expect(commitIdentity('{slug}@milibot.local', { name: 'Dex', slug: 'dex' })).toBe('dex@milibot.local')
  })
})
