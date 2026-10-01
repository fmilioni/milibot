import { promises as fsp, type Stats } from 'node:fs'
import path from 'node:path'

import { badRequest, notFound } from './errors.ts'
import { resolveWorkspacePath, WORKSPACE_ROOT } from './paths.ts'
import type { PasswdEntry } from './users.ts'

const MAX_READ_BYTES = 32 * 1024 * 1024

type Encoding = 'utf8' | 'base64'

function encoding(value: unknown): Encoding {
  if (value === undefined || value === 'utf8' || value === 'utf-8') return 'utf8'
  if (value === 'base64') return 'base64'
  throw badRequest('encoding must be utf8 or base64', 'invalid_encoding')
}

function kind(st: Stats): string {
  if (st.isFile()) return 'file'
  if (st.isDirectory()) return 'dir'
  if (st.isSymbolicLink()) return 'symlink'
  return 'other'
}

function describe(p: string, st: Stats) {
  return {
    path: p,
    type: kind(st),
    size: st.size,
    mode: (st.mode & 0o7777).toString(8),
    uid: st.uid,
    gid: st.gid,
    mtimeMs: Math.round(st.mtimeMs),
  }
}

async function statOrNotFound(p: string): Promise<Stats> {
  try {
    return await fsp.stat(p)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT')
      throw notFound(`no such path: ${p}`, 'path_not_found')
    throw err
  }
}

export async function fsRead(
  input: { path?: unknown; encoding?: unknown; maxBytes?: unknown; offset?: unknown },
  root = WORKSPACE_ROOT,
) {
  const p = resolveWorkspacePath(input.path, root)
  const enc = encoding(input.encoding)
  const st = await statOrNotFound(p)
  if (!st.isFile()) throw badRequest(`not a file: ${p}`, 'not_a_file')
  const maxBytes =
    typeof input.maxBytes === 'number' && input.maxBytes > 0
      ? Math.min(input.maxBytes, MAX_READ_BYTES)
      : MAX_READ_BYTES
  const offset = typeof input.offset === 'number' && input.offset > 0 ? Math.floor(input.offset) : 0
  const length = Math.max(0, Math.min(maxBytes, st.size - offset))
  const handle = await fsp.open(p, 'r')
  try {
    const buf = Buffer.alloc(length)
    const { bytesRead } = await handle.read(buf, 0, length, offset)
    const data = buf.subarray(0, bytesRead)
    return {
      path: p,
      size: st.size,
      offset,
      encoding: enc,
      content: data.toString(enc),
      truncated: offset + bytesRead < st.size,
    }
  } finally {
    await handle.close()
  }
}

async function mkdirpOwned(dir: string, owner: PasswdEntry, root: string): Promise<void> {
  const missing: string[] = []
  let current = dir
  while (current !== root && current !== '/') {
    try {
      await fsp.stat(current)
      break
    } catch {
      missing.push(current)
      current = path.posix.dirname(current)
    }
  }
  for (const d of missing.reverse()) {
    await fsp.mkdir(d, { mode: 0o2775 })
    await fsp.chown(d, owner.uid, -1)
  }
}

export async function fsWrite(
  input: {
    path?: unknown
    content?: unknown
    encoding?: unknown
    mkdirs?: unknown
    append?: unknown
    mode?: unknown
  },
  owner: PasswdEntry,
  root = WORKSPACE_ROOT,
) {
  const p = resolveWorkspacePath(input.path, root)
  if (p === root) throw badRequest('cannot write the workspace root', 'invalid_path')
  if (typeof input.content !== 'string') throw badRequest('content must be a string', 'invalid_content')
  const enc = encoding(input.encoding)
  const data = Buffer.from(input.content, enc)
  const dir = path.posix.dirname(p)
  if (input.mkdirs !== false) await mkdirpOwned(dir, owner, root)
  let existed = true
  try {
    const st = await fsp.lstat(p)
    if (!st.isFile()) throw badRequest(`not a regular file: ${p}`, 'not_a_file')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    existed = false
  }
  const mode =
    typeof input.mode === 'string' && /^[0-7]{3,4}$/.test(input.mode) ? parseInt(input.mode, 8) : 0o664
  if (input.append === true) await fsp.appendFile(p, data, { mode })
  else await fsp.writeFile(p, data, { mode })
  if (!existed) {
    await fsp.chown(p, owner.uid, -1)
    await fsp.chmod(p, mode)
  }
  const st = await fsp.stat(p)
  return describe(p, st)
}
