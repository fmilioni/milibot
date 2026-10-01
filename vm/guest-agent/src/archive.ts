import { execFile, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { promisify } from 'node:util'

import { badRequest, conflict } from './errors.ts'
import { dataDiskMounted, WORKSPACE_ROOT } from './paths.ts'
import { OutputTail } from './spawn.ts'

const execFileAsync = promisify(execFile)

const MAX_EXCLUDES = 100

export function parseExcludes(value: unknown): string[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value) || value.length > MAX_EXCLUDES)
    throw badRequest(`excludes must be an array (max ${MAX_EXCLUDES})`, 'invalid_excludes')
  return value.map((item) => {
    if (typeof item !== 'string' || !item.trim() || item.length > 200 || /[\n\r\0]/.test(item)) {
      throw badRequest('each exclude must be a non-empty single-line pattern', 'invalid_excludes')
    }
    return item.trim()
  })
}

/**
 * `tar` that writes the whole `/workspace` (relative paths) to stdout. Patterns without a slash match a file
 * or folder name at any depth (`node_modules`). Uncompressed: the host compresses it (faster there, and the
 * byte count is real progress against the estimate).
 */
export function tarCreateArgs(excludes: string[]): string[] {
  return [
    '-C',
    WORKSPACE_ROOT,
    '--numeric-owner',
    '--acls',
    '--warning=no-file-changed',
    '--warning=no-file-removed',
    '--warning=no-file-shrank',
    ...excludes.map((e) => `--exclude=${e}`),
    '-cf',
    '-',
    '.',
  ]
}

/** Restores owners (numeric: the bots keep their uids), permissions and ACLs. */
export function tarExtractArgs(): string[] {
  return ['-C', WORKSPACE_ROOT, '--numeric-owner', '--acls', '-xpf', '-']
}

export function duArgs(excludes: string[]): string[] {
  return ['-s', '-B1', '--apparent-size', ...excludes.map((e) => `--exclude=${e}`), WORKSPACE_ROOT]
}

export function duInodesArgs(excludes: string[]): string[] {
  return ['-s', '--inodes', ...excludes.map((e) => `--exclude=${e}`), WORKSPACE_ROOT]
}

function requireWorkspace(): void {
  if (!existsSync(WORKSPACE_ROOT) || !dataDiskMounted()) {
    throw conflict('the data disk is not mounted', 'data_disk_missing')
  }
}

async function duTotal(args: string[]): Promise<number> {
  try {
    const { stdout } = await execFileAsync('du', args, { timeout: 300_000, maxBuffer: 1024 * 1024 })
    return Number(stdout.trim().split(/\s+/)[0]) || 0
  } catch (err) {
    // du exits 1 when a file vanished or is unreadable but still prints the total.
    const out = (err as { stdout?: string }).stdout ?? ''
    const total = Number(out.trim().split('\n').pop()?.split(/\s+/)[0])
    if (Number.isFinite(total) && total > 0) return total
    throw err
  }
}

/** Apparent size and number of entries (files + folders) of `/workspace` without the excludes. */
export async function estimateWorkspace(excludes: string[]): Promise<{ bytes: number; entries: number }> {
  requireWorkspace()
  const [bytes, entries] = await Promise.all([duTotal(duArgs(excludes)), duTotal(duInodesArgs(excludes))])
  return { bytes, entries }
}

/**
 * Streams the tar of `/workspace`. A failure after the headers went out destroys the connection, so the
 * client sees a broken download instead of a short archive that looks complete.
 */
export function streamWorkspaceTar(req: IncomingMessage, res: ServerResponse, excludes: string[]): void {
  requireWorkspace()
  const child = spawn('tar', tarCreateArgs(excludes), { stdio: ['ignore', 'pipe', 'pipe'] })
  const stderr = new OutputTail(4000)
  child.stderr.on('data', stderr.push)
  res.writeHead(200, { 'content-type': 'application/x-tar', 'cache-control': 'no-store' })
  child.stdout.pipe(res, { end: false })
  req.on('close', () => {
    if (child.exitCode === null) child.kill('SIGTERM')
  })
  child.on('close', (code) => {
    // 1 = some files changed while being read: the archive is still complete.
    if (code === 0 || code === 1) {
      res.end()
    } else {
      console.error(`workspace tar failed (${code}): ${stderr.text.trim()}`)
      res.destroy(new Error(`tar exited with ${code}`))
    }
  })
}

/** Extracts a tar sent as the request body into `/workspace` (files already there are overwritten). */
export function extractWorkspaceTar(
  req: IncomingMessage,
): Promise<{ ok: boolean; code: number | null; stderr: string }> {
  requireWorkspace()
  return new Promise((resolve, reject) => {
    const child = spawn('tar', tarExtractArgs(), { stdio: ['pipe', 'ignore', 'pipe'] })
    const stderr = new OutputTail(4000)
    child.stderr.on('data', stderr.push)
    child.stdin.on('error', () => undefined)
    req.pipe(child.stdin)
    req.on('close', () => {
      if (!req.complete) child.kill('SIGTERM')
    })
    child.on('error', reject)
    child.on('close', (code) => resolve({ ok: code === 0, code, stderr: stderr.text.trim() }))
  })
}
