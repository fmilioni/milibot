import { execFile } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { connect } from 'node:net'
import { promisify } from 'node:util'

import type { ProvisionedBot } from '@milibot/shared/portable/guest-api'
import {
  BOT_SLUG_MAX_LENGTH,
  isBotSlug,
  MAX_BOT_UID,
  MIN_BOT_UID,
} from '@milibot/shared/portable/guest-constants'
import { VNC_DISPLAYS, VNC_PORT_BASE } from '@milibot/shared/portable/platform'

import { badRequest, conflict, HttpError, notFound } from './errors.ts'
import { lookupUser } from './users.ts'

const execFileAsync = promisify(execFile)

const BOTS_DIR = '/etc/milibot/bots'
const BOT_TOOL = '/opt/milibot/bin/milibot-bot'

export type BotInfo = Omit<ProvisionedBot, 'ready'>

export function validateSlug(slug: unknown): string {
  if (typeof slug !== 'string' || !isBotSlug(slug)) {
    throw badRequest(
      `slug must match ^[a-z][a-z0-9-]*$ (max ${BOT_SLUG_MAX_LENGTH} chars, no leading/trailing/double hyphen)`,
      'invalid_slug',
    )
  }
  return slug
}

export function validateDisplay(display: unknown): number {
  const n = typeof display === 'string' ? Number(display) : display
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > VNC_DISPLAYS) {
    throw badRequest(`display must be an integer 1..${VNC_DISPLAYS}`, 'invalid_display')
  }
  return n
}

export function validateUid(uid: unknown): number {
  if (typeof uid !== 'number' || !Number.isInteger(uid) || uid < MIN_BOT_UID || uid > MAX_BOT_UID) {
    throw badRequest(`uid must be an integer ${MIN_BOT_UID}..${MAX_BOT_UID}`, 'invalid_uid')
  }
  return uid
}

function parseEnvFile(content: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of content.split('\n')) {
    const m = /^([A-Z_]+)=(.*)$/.exec(line.trim())
    if (m) out[m[1]!] = m[2]!
  }
  return out
}

export function listBots(dir = BOTS_DIR): BotInfo[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((f) => f.endsWith('.env'))
    .map((f) => {
      const env = parseEnvFile(readFileSync(`${dir}/${f}`, 'utf8'))
      const slug = f.slice(0, -4)
      const display = Number(env.DISPLAY_NUM)
      const user = `bot-${slug}`
      return {
        slug,
        user,
        uid: Number(env.BOT_UID),
        display,
        vncPort: VNC_PORT_BASE + display,
        home: lookupUser(user)?.home ?? `/home/${user}`,
      }
    })
    .sort((a, b) => a.display - b.display)
}

export function botForDisplay(display: number): BotInfo {
  const bot = listBots().find((b) => b.display === display)
  if (!bot) throw notFound(`no bot on display :${display}`, 'unknown_display')
  return bot
}

function portOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = connect({ host: '127.0.0.1', port })
    sock.once('connect', () => {
      sock.destroy()
      resolve(true)
    })
    sock.once('error', () => resolve(false))
  })
}

export async function displayRunning(display: number): Promise<boolean> {
  return existsSync(`/tmp/.X11-unix/X${display}`) && (await portOpen(VNC_PORT_BASE + display))
}

async function waitForDesktop(display: number, timeoutMs = 30_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await displayRunning(display)) return true
    await new Promise((r) => setTimeout(r, 250))
  }
  return false
}

async function desktopActive(slug: string, display: number): Promise<boolean> {
  if (!(await displayRunning(display))) return false
  try {
    await execFileAsync('systemctl', ['is-active', '--quiet', `milibot-desktop@${slug}.service`], {
      timeout: 10_000,
    })
    return true
  } catch {
    return false
  }
}

async function runTool(args: string[]): Promise<void> {
  try {
    await execFileAsync(BOT_TOOL, args, { timeout: 120_000, maxBuffer: 4 * 1024 * 1024 })
  } catch (err) {
    const e = err as { code?: number; stderr?: string; message: string }
    const stderr = (e.stderr ?? '').trim()
    const codeLine = /^MILIBOT_ERROR=([a-z_]+)$/m.exec(stderr)
    if (codeLine)
      throw new HttpError(
        409,
        codeLine[1]!,
        stderr
          .split('\n')
          .filter((l) => !l.startsWith('MILIBOT_ERROR='))
          .pop() ?? codeLine[1]!,
      )
    throw new HttpError(500, 'bot_tool_failed', stderr || e.message)
  }
}

export async function provisionBot(input: {
  slug?: unknown
  uid?: unknown
  display?: unknown
}): Promise<ProvisionedBot> {
  const slug = validateSlug(input.slug)
  const uid = validateUid(input.uid)
  const display = validateDisplay(input.display)
  const other = listBots().find((b) => b.display === display && b.slug !== slug)
  if (other) throw conflict(`display :${display} is used by ${other.slug}`, 'display_in_use')
  const current = listBots().find((b) => b.slug === slug)
  // Provisioning restarts the desktop service, which would kill the bot's open terminals and browser.
  if (
    current &&
    current.uid === uid &&
    current.display === display &&
    lookupUser(current.user) &&
    (await desktopActive(slug, display))
  ) {
    return { ...current, ready: true }
  }
  await runTool(['provision', slug, String(uid), String(display)])
  const ready = await waitForDesktop(display)
  const bot = listBots().find((b) => b.slug === slug)
  if (!bot) throw new HttpError(500, 'bot_tool_failed', 'bot registry missing after provisioning')
  return { ...bot, ready }
}

export async function removeBot(input: {
  slug?: unknown
  deleteHome?: unknown
}): Promise<{ slug: string; removed: boolean }> {
  const slug = validateSlug(input.slug)
  await runTool(['remove', slug, ...(input.deleteHome === true ? ['--delete-home'] : [])])
  return { slug, removed: true }
}
