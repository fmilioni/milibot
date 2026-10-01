import { spawn } from 'node:child_process'
import { existsSync, promises as fsp } from 'node:fs'
import type { IncomingMessage } from 'node:http'
import os from 'node:os'
import path from 'node:path'

import { type ExtractResult, MAX_EXTRACT_BYTES } from '@milibot/shared/portable/guest-api'

import { badRequest, HttpError } from '../errors.ts'
import { readBody } from '../http.ts'
import { SYSTEMD_RUN } from '../limits.ts'
import { armTimeout, killGroup, OutputTail } from '../spawn.ts'
import { DEFAULT_PATH, lookupUser } from '../users.ts'
import {
  extractDocument,
  type ExtractRunner,
  type ExtractWorkdir,
  type RunResult,
  unsupportedFormat,
} from './extract.ts'
import { detectKind, extensionOf, parseKind } from './kind.ts'
import type { ExtractTools } from './tools.ts'

const MAX_STDOUT = 96 * 1024 * 1024
const MAX_CONCURRENT = 2

interface Sandbox {
  uid: number
  gid: number
}

function sandboxUser(): Sandbox {
  const nobody = lookupUser('nobody')
  return nobody ? { uid: nobody.uid, gid: nobody.gid } : { uid: 65534, gid: 65534 }
}

function memoryMaxMb(): number {
  return Math.max(512, Math.min(3072, Math.floor(os.totalmem() / 1024 / 1024 / 2)))
}

/** Transient scope with a memory cap and low CPU weight, running as `nobody` without privileges to gain. */
export function sandboxArgv(
  argv: string[],
  user: Sandbox,
  memoryMb: number,
  systemd = true,
): { file: string; args: string[] } {
  const setpriv = [
    '/usr/bin/setpriv',
    `--reuid=${user.uid}`,
    `--regid=${user.gid}`,
    '--clear-groups',
    '--no-new-privs',
    '--',
    ...argv,
  ]
  if (!systemd) return { file: setpriv[0]!, args: setpriv.slice(1) }
  return {
    file: SYSTEMD_RUN,
    args: [
      '--scope',
      '--quiet',
      '--collect',
      `--property=MemoryMax=${memoryMb}M`,
      '--property=CPUWeight=20',
      '--',
      ...setpriv,
    ],
  }
}

function sandboxRunner(dir: string, user: Sandbox): ExtractRunner {
  const memoryMb = memoryMaxMb()
  const systemd = existsSync(SYSTEMD_RUN)
  return {
    run: (argv, timeoutMs) =>
      new Promise<RunResult>((resolve, reject) => {
        const { file, args } = sandboxArgv(argv, user, memoryMb, systemd)
        const child = spawn(file, args, {
          cwd: dir,
          detached: true,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: {
            PATH: DEFAULT_PATH,
            HOME: dir,
            TMPDIR: dir,
            LANG: 'C.UTF-8',
            LC_ALL: 'C.UTF-8',
            OMP_THREAD_LIMIT: '1',
          },
        })
        const chunks: Buffer[] = []
        let size = 0
        const stderr = new OutputTail(8000)
        let timedOut = false
        const cancelTimeout = armTimeout(child, timeoutMs, () => {
          timedOut = true
        })
        child.stdout.on('data', (c: Buffer) => {
          size += c.length
          if (size > MAX_STDOUT) return void killGroup(child, 'SIGKILL')
          chunks.push(c)
        })
        child.stderr.on('data', stderr.push)
        child.on('error', (err) => {
          cancelTimeout()
          reject(err)
        })
        child.on('close', (code) => {
          cancelTimeout()
          const tooLarge = size > MAX_STDOUT
          const message = tooLarge
            ? `${stderr.text}\noutput larger than ${MAX_STDOUT / 1024 / 1024} MB`
            : stderr.text
          resolve({ code: tooLarge ? null : code, stdout: Buffer.concat(chunks), stderr: message, timedOut })
        })
      }),
  }
}

async function createWorkdir(name: string, bytes: Uint8Array, user: Sandbox): Promise<ExtractWorkdir> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'milibot-extract-'))
  await fsp.chmod(dir, 0o700)
  await fsp.chown(dir, user.uid, user.gid)
  const writeFile = async (file: string, content: string | Uint8Array) => {
    const target = path.join(dir, file)
    await fsp.writeFile(target, content, { mode: 0o600 })
    await fsp.chown(target, user.uid, user.gid)
    return target
  }
  const ext = extensionOf(name)
  const input = await writeFile(/^[a-z0-9]{1,8}$/.test(ext) ? `input.${ext}` : 'input', bytes)
  const exists = (p: string) =>
    fsp.access(p).then(
      () => true,
      () => false,
    )
  return { dir, input, writeFile, remove: (p) => fsp.rm(p, { force: true }), exists }
}

function pageParam(url: URL, key: string): number | null {
  const raw = url.searchParams.get(key)
  if (raw === null || raw === '') return null
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 1) throw badRequest(`${key} must be a page number >= 1`, 'invalid_pages')
  return n
}

let active = 0
const waiting: Array<() => void> = []

async function slot(): Promise<() => void> {
  if (active >= MAX_CONCURRENT) await new Promise<void>((resolve) => waiting.push(resolve))
  active++
  return () => {
    active--
    waiting.shift()?.()
  }
}

/** `POST /extract?name=&kind=&first=&last=` with the file as the body. */
export async function handleExtract(
  req: IncomingMessage,
  url: URL,
  tools: ExtractTools,
): Promise<ExtractResult> {
  const name = url.searchParams.get('name') ?? ''
  const requested = parseKind(url.searchParams.get('kind'))
  const first = pageParam(url, 'first')
  const last = pageParam(url, 'last')
  const bytes = await readBody(
    req,
    MAX_EXTRACT_BYTES,
    () => new HttpError(413, 'too_large', `the file is larger than ${MAX_EXTRACT_BYTES / 1024 / 1024} MB`),
  )
  const kind = requested ?? detectKind(name, bytes)
  if (!kind)
    throw unsupportedFormat(`cannot extract text from ${name || 'this file'}: unknown or binary format`)
  tools.ensure(kind)
  const release = await slot()
  const user = sandboxUser()
  let workdir: ExtractWorkdir | null = null
  try {
    workdir = await createWorkdir(name, bytes, user)
    return await extractDocument(
      bytes,
      { name, kind, first, last },
      { runner: sandboxRunner(workdir.dir, user), workdir },
    )
  } finally {
    release()
    if (workdir) await fsp.rm(workdir.dir, { recursive: true, force: true }).catch(() => undefined)
  }
}
