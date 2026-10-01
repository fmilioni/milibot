import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { promisify } from 'node:util'

import type { BotLimits } from '@milibot/shared/portable/guest-api'

import { validateSlug, validateUid } from './bots.ts'
import { badRequest } from './errors.ts'
import type { Json } from './http.ts'
import type { SpawnSpec } from './users.ts'

const execFileAsync = promisify(execFile)

export const SYSTEMD_RUN = '/usr/bin/systemd-run'
const SYSTEMCTL = '/usr/bin/systemctl'
const DROP_IN_DIR = '/etc/systemd/system'
const DROP_IN_NAME = '10-milibot-slice.conf'

export interface BotRef {
  slug: string
  uid: number
}

/**
 * `milibot-bot-<slug>.slice`. A dash in a slice name means nesting (`a-b.slice` lives inside `a.slice`), so
 * dashes of the slug are escaped like `systemd-escape` does: bot `code-review` must not land inside bot `code`.
 */
export function botSliceName(slug: string): string {
  return `milibot-bot-${slug.replaceAll('-', '\\x2d')}.slice`
}

export function userSliceName(uid: number): string {
  return `user-${uid}.slice`
}

export function parseLimits(value: unknown): BotLimits | null {
  if (value === null || value === undefined) return null
  if (typeof value !== 'object' || Array.isArray(value))
    throw badRequest('limits must be an object or null', 'invalid_limits')
  const { cpuPercent, memoryMb } = value as Record<string, unknown>
  const check = (v: unknown, name: string, min: number, max: number): number | null => {
    if (v === null || v === undefined) return null
    if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) {
      throw badRequest(`${name} must be an integer ${min}..${max}`, 'invalid_limits')
    }
    return v
  }
  return {
    cpuPercent: check(cpuPercent, 'cpuPercent', 1, 100_000),
    memoryMb: check(memoryMb, 'memoryMb', 64, 16_777_216),
  }
}

/** Properties for `systemctl set-property`; no limits resets both (empty CPUQuota = no quota). */
export function limitProperties(limits: BotLimits | null): string[] {
  return [
    `CPUQuota=${limits?.cpuPercent ? `${limits.cpuPercent}%` : ''}`,
    `MemoryMax=${limits?.memoryMb ? `${limits.memoryMb}M` : 'infinity'}`,
  ]
}

/** `--runtime`: every boot starts without limits until the daemon applies the current ones. */
export function setPropertyArgs(unit: string, limits: BotLimits | null): string[] {
  return ['set-property', '--runtime', unit, ...limitProperties(limits)]
}

/**
 * Runs the command in a transient scope inside the bot's slice (systemd-run execs it: same pid, same pipes).
 * `OOMPolicy=continue`: hitting the memory limit kills the process that used the most, not the whole scope
 * (a build that blows up must not take the bot's Claude Code process with it).
 */
export function inBotSlice(spec: SpawnSpec, slug: string): SpawnSpec {
  return {
    file: SYSTEMD_RUN,
    args: [
      '--scope',
      '--quiet',
      '--collect',
      `--slice=${botSliceName(slug)}`,
      '--property=OOMPolicy=continue',
      '--',
      spec.file,
      ...spec.args,
    ],
    env: spec.env,
  }
}

export function desktopDropIn(slug: string): { dir: string; file: string; content: string } {
  const dir = `${DROP_IN_DIR}/milibot-desktop@${slug}.service.d`
  return {
    dir,
    file: `${dir}/${DROP_IN_NAME}`,
    content: `[Service]\nSlice=${botSliceName(slug)}\nOOMPolicy=continue\n`,
  }
}

async function systemctl(args: string[]): Promise<void> {
  await execFileAsync(SYSTEMCTL, args, { timeout: 30_000 })
}

/** Puts the bot's desktop service in its slice (takes effect on the next start of the service). */
export async function ensureDesktopSlice(slug: string): Promise<void> {
  const dropIn = desktopDropIn(slug)
  if (existsSync(dropIn.file) && readFileSync(dropIn.file, 'utf8') === dropIn.content) return
  mkdirSync(dropIn.dir, { recursive: true })
  writeFileSync(dropIn.file, dropIn.content)
  await systemctl(['daemon-reload'])
}

export async function removeDesktopSlice(slug: string): Promise<void> {
  const dropIn = desktopDropIn(slug)
  if (!existsSync(dropIn.dir)) return
  rmSync(dropIn.dir, { recursive: true, force: true })
  await systemctl(['daemon-reload']).catch(() => undefined)
}

export interface AppliedLimits {
  slug: string
  ok: boolean
  error?: string
}

/** Sets (or clears) the limits of each bot's slice and of its login slice (`user-<uid>.slice`). */
async function applyLimits(bots: BotRef[], limits: BotLimits | null): Promise<AppliedLimits[]> {
  const results: AppliedLimits[] = []
  for (const bot of bots) {
    try {
      await systemctl(setPropertyArgs(botSliceName(bot.slug), limits))
      await systemctl(setPropertyArgs(userSliceName(bot.uid), limits))
      results.push({ slug: bot.slug, ok: true })
    } catch (err) {
      const e = err as { stderr?: string; message: string }
      results.push({ slug: bot.slug, ok: false, error: (e.stderr || e.message).trim().slice(0, 500) })
    }
  }
  return results
}

/** `POST /limits {bots: [{slug, uid}], limits}` */
export function handleLimits(body: Json): Promise<AppliedLimits[]> {
  if (!Array.isArray(body.bots)) throw badRequest('bots must be an array', 'invalid_bots')
  const bots = (body.bots as Array<Record<string, unknown>>).map((b) => ({
    slug: validateSlug(b?.slug),
    uid: validateUid(b?.uid),
  }))
  return applyLimits(bots, parseLimits(body.limits))
}
