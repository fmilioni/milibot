import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'

import type { ExecResult } from '@milibot/shared/portable/guest-api'

import { validateDisplay, validateSlug } from './bots.ts'
import { badRequest } from './errors.ts'
import type { Json } from './http.ts'
import { inBotSlice } from './limits.ts'
import { WORKSPACE_ROOT } from './paths.ts'
import { armTimeout } from './spawn.ts'
import { buildRunAs, requireUser, type SpawnSpec } from './users.ts'

const DEFAULT_MAX_OUTPUT = 1024 * 1024
const MAX_OUTPUT = 16 * 1024 * 1024

export interface ExecOptions {
  cwd: string
  timeoutMs: number
  maxOutputBytes: number
  stdin?: string
}

class Capped {
  private chunks: Buffer[] = []
  private size = 0
  truncated = false

  constructor(private readonly max: number) {}

  push(chunk: Buffer): void {
    const room = this.max - this.size
    if (room <= 0) {
      this.truncated = true
      return
    }
    const part = chunk.length > room ? chunk.subarray(0, room) : chunk
    if (part.length < chunk.length) this.truncated = true
    this.chunks.push(part)
    this.size += part.length
  }

  text(): string {
    return Buffer.concat(this.chunks).toString('utf8')
  }
}

export function clampTimeout(value: unknown, fallback = 120_000, max = 3_600_000): number {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0)
    throw badRequest('timeoutMs must be > 0', 'invalid_timeout')
  return Math.min(Math.round(value), max)
}

/** User, folder and command of a `POST /exec` or `POST /procs` body. */
export function execParams(body: Json) {
  const user = requireUser(body.user ?? 'agent')
  const cwd = body.cwd === undefined ? WORKSPACE_ROOT : body.cwd
  if (typeof cwd !== 'string' || !cwd.startsWith('/'))
    throw badRequest('cwd must be an absolute path', 'invalid_cwd')
  if (!existsSync(cwd)) throw badRequest(`cwd does not exist: ${cwd}`, 'invalid_cwd')
  const argv = body.argv
  if (argv !== undefined && (!Array.isArray(argv) || argv.some((a) => typeof a !== 'string'))) {
    throw badRequest('argv must be an array of strings', 'invalid_command')
  }
  const display = body.display === undefined ? undefined : validateDisplay(body.display)
  const bot = body.bot === undefined ? undefined : validateSlug(body.bot)
  const runAs = buildRunAs({
    user,
    ...(typeof body.cmd === 'string' ? { cmd: body.cmd } : {}),
    ...(argv ? { argv: argv as string[] } : {}),
    ...(body.env ? { env: body.env as Record<string, string> } : {}),
    ...(display !== undefined ? { display } : {}),
  })
  // Work done for a bot runs in its slice, so its CPU/memory limits cover it.
  const spec = bot ? inBotSlice(runAs, bot) : runAs
  return { user, cwd, spec }
}

/** `POST /exec`: runs the command to completion. */
export function handleExec(body: Json): Promise<ExecResult> {
  const { cwd, spec } = execParams(body)
  const maxOutputBytes =
    typeof body.maxOutputBytes === 'number' && body.maxOutputBytes > 0
      ? Math.min(body.maxOutputBytes, MAX_OUTPUT)
      : DEFAULT_MAX_OUTPUT
  return runCommand(spec, {
    cwd,
    timeoutMs: clampTimeout(body.timeoutMs),
    maxOutputBytes,
    ...(typeof body.stdin === 'string' ? { stdin: body.stdin } : {}),
  })
}

export function runCommand(spec: SpawnSpec, opts: ExecOptions): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const child = spawn(spec.file, spec.args, {
      cwd: opts.cwd,
      env: spec.env,
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const out = new Capped(opts.maxOutputBytes)
    const err = new Capped(opts.maxOutputBytes)
    let timedOut = false
    const cancelTimeout = armTimeout(child, opts.timeoutMs, () => {
      timedOut = true
    })
    child.stdout.on('data', (c: Buffer) => out.push(c))
    child.stderr.on('data', (c: Buffer) => err.push(c))
    child.stdin.on('error', () => {})
    child.stdin.end(opts.stdin ?? '')
    child.on('error', (e) => {
      cancelTimeout()
      reject(e)
    })
    child.on('close', (code, signal) => {
      cancelTimeout()
      resolve({
        code,
        signal,
        stdout: out.text(),
        stderr: err.text(),
        truncated: { stdout: out.truncated, stderr: err.truncated },
        timedOut,
        durationMs: Date.now() - started,
      })
    })
  })
}
