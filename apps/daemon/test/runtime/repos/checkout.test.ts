import type { ExecResult, GuestExecRequest } from '@milibot/shared'
import { describe, expect, it } from 'vitest'

import { isRepoUrl, runCheckout, sanitizeRepoName, slugPart } from '../../../src/runtime/repos/checkout'
import { CHECKOUT_SCRIPT } from '../../../src/runtime/repos/scripts/checkout.generated'
import type { GuestClient } from '../../../src/runtime/vm/guest-client'

describe('repos', () => {
  it('derives a repository name from a URL or a name', () => {
    expect(sanitizeRepoName('https://github.com/acme/web-app.git')).toBe('web-app')
    expect(sanitizeRepoName('git@github.com:acme/api.git/')).toBe('api')
    expect(sanitizeRepoName('my repo!')).toBe('my-repo-')
    expect(() => sanitizeRepoName('...')).toThrow('could not derive a repository name')
  })

  it('names branches from the task, cut at 40 characters', () => {
    expect(slugPart('Fix the login bug!', 'work')).toBe('fix-the-login-bug')
    expect(slugPart(undefined, 'work')).toBe('work')
    expect(slugPart('a'.repeat(39) + ' bcd', 'work')).toBe(`${'a'.repeat(39)}-`)
  })

  it('tells clone URLs from repository names', () => {
    for (const url of ['https://github.com/a/b', 'git@github.com:a/b', 'ssh://h/r', 'file:///srv/r', 'u@h:r'])
      expect(isRepoUrl(url)).toBe(true)
    expect(isRepoUrl('web-app')).toBe(false)
  })

  it('runs the checkout script as the bot and reads its KEY=VALUE lines', async () => {
    const requests: GuestExecRequest[] = []
    const guest = {
      exec: async (request: GuestExecRequest): Promise<ExecResult> => {
        requests.push(request)
        return {
          code: 0,
          signal: null,
          stdout: 'STATUS=created\nBASE=main\nBRANCH=bot/nina/work\n',
          stderr: '',
          truncated: { stdout: false, stderr: false },
          timedOut: false,
          durationMs: 1,
        }
      },
    } as unknown as GuestClient
    const result = await runCheckout(guest, {
      bot: { name: 'Nina', slug: 'nina' },
      repo: 'https://github.com/acme/web.git',
      name: 'web',
      branch: 'bot/nina/work',
      baseBranch: '',
      worktreePath: '/workspace/sessions/web-1',
      botEnv: { GIT_AUTHOR_NAME: 'Nina Bot', GH_TOKEN: 'x' },
    })
    expect(result.info).toEqual({ STATUS: 'created', BASE: 'main', BRANCH: 'bot/nina/work' })
    expect(requests[0]).toMatchObject({
      user: 'bot-nina',
      cmd: CHECKOUT_SCRIPT,
      cwd: '/workspace',
      env: {
        GH_TOKEN: 'x',
        GIT_NAME: 'Nina Bot',
        GIT_EMAIL: 'nina@milibot.local',
        REPO_URL: 'https://github.com/acme/web.git',
        REPO_NAME: 'web',
        BOT_SLUG: 'nina',
        BRANCH: 'bot/nina/work',
        BASE_BRANCH: '',
        WT_PATH: '/workspace/sessions/web-1',
        GIT_TERMINAL_PROMPT: '0',
      },
    })
    await runCheckout(guest, {
      bot: { name: 'Nina', slug: 'nina' },
      repo: 'web',
      name: 'web',
      branch: 'b',
      baseBranch: 'dev',
      botEnv: {},
    })
    expect(requests[1]?.env).toMatchObject({ REPO_URL: '', GIT_NAME: 'Nina (Milibot)', BASE_BRANCH: 'dev' })
    expect(requests[1]?.env).not.toHaveProperty('WT_PATH')
  })
})
