import { existsSync, readdirSync, readFileSync } from 'node:fs'

import {
  AGENT_UID,
  BOT_SLUG_MAX_LENGTH,
  BOT_SLUG_PATTERN,
  DOCKER_GID,
  EXTRACT_PACKAGES,
  isBotSlug,
  MAX_BOT_UID,
  MIN_BOT_UID,
  WORKSPACE_GID,
} from '@milibot/shared/portable/guest-constants'
import {
  CDP_PORT_BASE,
  GUEST_AGENT_PORT,
  VNC_DISPLAYS,
  VNC_PORT_BASE,
} from '@milibot/shared/portable/platform'
import { describe, expect, it } from 'vitest'

const VM = new URL('../../', import.meta.url)
const read = (relative: string) => readFileSync(new URL(relative, VM), 'utf8')

/** `provision.sh` plus its steps in `provision.d/` (when split). */
function provisionText(): string {
  const steps = existsSync(new URL('provision.d/', VM))
    ? readdirSync(new URL('provision.d/', VM))
        .filter((name) => name.endsWith('.sh'))
        .sort()
        .map((name) => read(`provision.d/${name}`))
    : []
  return [read('provision.sh'), ...steps].join('\n')
}

const literal = (text: string) => new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))

describe('guest constants match the guest shell scripts', () => {
  it('uses the same agent and group ids', () => {
    const provision = provisionText()
    for (const text of [provision, read('guest/bin/milibot-data-setup')]) {
      expect(text).toMatch(new RegExp(`^AGENT_UID=${AGENT_UID}$`, 'm'))
      expect(text).toMatch(new RegExp(`^WORKSPACE_GID=${WORKSPACE_GID}$`, 'm'))
    }
    expect(provision).toMatch(new RegExp(`^DOCKER_GID=${DOCKER_GID}$`, 'm'))
  })

  it('installs the extraction packages in the image', () => {
    const provision = provisionText()
    for (const pkg of EXTRACT_PACKAGES) expect(provision).toMatch(new RegExp(`\\s${pkg}(\\s|$)`))
  })

  it('validates bots like the guest agent', () => {
    const bot = read('guest/bin/milibot-bot')
    expect(bot).toMatch(
      literal(`[[ "$1" =~ ${BOT_SLUG_PATTERN.source} ]] && [ \${#1} -le ${BOT_SLUG_MAX_LENGTH} ]`),
    )
    expect(bot).toMatch(literal(`[ "$uid" -ge ${MIN_BOT_UID} ] && [ "$uid" -le ${MAX_BOT_UID} ]`))
    expect(bot).toMatch(literal(`[ "$display" -ge 1 ] && [ "$display" -le ${VNC_DISPLAYS} ]`))
    expect(isBotSlug('lead-dev2')).toBe(true)
    for (const slug of ['2lead', 'lead-', 'le--ad', 'Lead', 'a'.repeat(BOT_SLUG_MAX_LENGTH + 1)]) {
      expect(isBotSlug(slug)).toBe(false)
    }
  })

  it('uses the same ports', () => {
    expect(read('guest/systemd/milibot-guest-agent.service')).toMatch(
      new RegExp(`^Environment=MILIBOT_AGENT_PORT=${GUEST_AGENT_PORT}$`, 'm'),
    )
    expect(read('guest/bin/milibot-browser')).toMatch(literal(`port=$((${CDP_PORT_BASE} + display_num))`))
    expect(read('guest/bin/milibot-desktop-session')).toMatch(literal(`-rfbport $((${VNC_PORT_BASE} + N))`))
  })
})
