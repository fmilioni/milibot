import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { MAX_BOT_UID, MIN_BOT_UID } from '@milibot/shared/portable/guest-constants'
import { VNC_DISPLAYS, VNC_PORT_BASE } from '@milibot/shared/portable/platform'
import { afterAll, describe, expect, it } from 'vitest'

import { listBots, validateDisplay, validateSlug, validateUid } from '../src/bots.ts'
import { health } from '../src/health.ts'

const DIR = mkdtempSync(join(tmpdir(), 'milibot-bots-'))
afterAll(() => rmSync(DIR, { recursive: true, force: true }))

describe('bot input', () => {
  it('accepts slugs, uids and displays in range and refuses the rest with a code', () => {
    expect(validateSlug('lead-dev')).toBe('lead-dev')
    expect(validateUid(MIN_BOT_UID)).toBe(MIN_BOT_UID)
    expect(validateUid(MAX_BOT_UID)).toBe(MAX_BOT_UID)
    expect(validateDisplay('3')).toBe(3)
    expect(validateDisplay(VNC_DISPLAYS)).toBe(VNC_DISPLAYS)
    const code = (run: () => unknown) => {
      try {
        run()
      } catch (err) {
        return (err as { code: string }).code
      }
      return null
    }
    expect(code(() => validateSlug('-x'))).toBe('invalid_slug')
    expect(code(() => validateSlug(7))).toBe('invalid_slug')
    expect(code(() => validateUid(MIN_BOT_UID - 1))).toBe('invalid_uid')
    expect(code(() => validateUid('2001'))).toBe('invalid_uid')
    expect(code(() => validateDisplay(0))).toBe('invalid_display')
    expect(code(() => validateDisplay(VNC_DISPLAYS + 1))).toBe('invalid_display')
  })
})

describe('bot registry', () => {
  it('lists the env files by display, with their VNC port', () => {
    const dir = join(DIR, 'bots')
    mkdirSync(dir)
    writeFileSync(join(dir, 'zed.env'), 'BOT_UID=2002\nDISPLAY_NUM=1\n')
    writeFileSync(join(dir, 'amy.env'), 'BOT_UID=2001\nDISPLAY_NUM=4\n')
    writeFileSync(join(dir, 'notes.txt'), 'ignored')
    expect(listBots(dir)).toEqual([
      {
        slug: 'zed',
        user: 'bot-zed',
        uid: 2002,
        display: 1,
        vncPort: VNC_PORT_BASE + 1,
        home: '/home/bot-zed',
      },
      {
        slug: 'amy',
        user: 'bot-amy',
        uid: 2001,
        display: 4,
        vncPort: VNC_PORT_BASE + 4,
        home: '/home/bot-amy',
      },
    ])
    expect(listBots(join(DIR, 'missing'))).toEqual([])
  })
})

describe('health', () => {
  it('reports the agent sha, the data disk and which desktops run', async () => {
    const bots = listBots(join(DIR, 'bots'))
    const result = await health('0123456789abcdef', {
      bots: () => bots,
      displayRunning: async (display) => display === 4,
      dataDiskMounted: () => true,
    })
    expect(result).toMatchObject({ ok: true, agentSha: '0123456789abcdef', dataDiskMounted: true })
    expect(result.node).toBe(process.version)
    expect(result.displays.map((d) => [d.slug, d.uid, d.display, d.running])).toEqual([
      ['zed', 2002, 1, false],
      ['amy', 2001, 4, true],
    ])
  })
})
