// tar.gz of the build payload (ustar, no external tar).
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

import { BuildError } from './log.ts'

export type TarEntry =
  { name: string; mode: number; dir: true } | { name: string; mode: number; data: Buffer }

/** Executable bits cannot be read on Windows: scripts and `bin/` files get 0755 there. */
function modeOf(stat: fs.Stats, rel: string): number {
  if (process.platform !== 'win32') return stat.mode & 0o7777
  if (stat.isDirectory()) return 0o755
  return /(^|\/)bin\/|\.(sh|mjs)$/.test(rel) ? 0o755 : 0o644
}

function tarHeader(name: string, size: number, mode: number, type: '0' | '5', mtime: number): Buffer {
  const header = Buffer.alloc(512)
  let prefix = ''
  let base = name
  if (Buffer.byteLength(name) > 100) {
    const cut = name.lastIndexOf('/', 155)
    if (cut <= 0 || Buffer.byteLength(name.slice(cut + 1)) > 100)
      throw new BuildError(`path too long for tar: ${name}`)
    prefix = name.slice(0, cut)
    base = name.slice(cut + 1)
  }
  const octal = (value: number, length: number) => value.toString(8).padStart(length - 1, '0') + '\0'
  header.write(base, 0, 100)
  header.write(octal(mode, 8), 100)
  header.write(octal(0, 8), 108)
  header.write(octal(0, 8), 116)
  header.write(octal(size, 12), 124)
  header.write(octal(mtime, 12), 136)
  header.fill(' ', 148, 156)
  header.write(type, 156)
  header.write('ustar\0', 257)
  header.write('00', 263)
  header.write(prefix, 345, 155)
  let sum = 0
  for (const byte of header) sum += byte
  header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148)
  return header
}

export function tarGz(entries: TarEntry[]): Buffer {
  const blocks: Buffer[] = []
  const mtime = Math.floor(Date.now() / 1000)
  for (const e of entries) {
    if ('dir' in e) {
      blocks.push(tarHeader(`${e.name}/`, 0, e.mode, '5', mtime))
      continue
    }
    blocks.push(tarHeader(e.name, e.data.length, e.mode, '0', mtime), e.data)
    const pad = (512 - (e.data.length % 512)) % 512
    if (pad) blocks.push(Buffer.alloc(pad))
  }
  blocks.push(Buffer.alloc(1024))
  return zlib.gzipSync(Buffer.concat(blocks))
}

/** Entries of a folder tree (sorted, `./`-relative names like `tar -C dir .`), the folder itself first. */
function treeEntries(root: string, prefix: string): TarEntry[] {
  const out: TarEntry[] = [{ name: prefix, dir: true, mode: modeOf(fs.statSync(root), `${prefix}/`) }]
  for (const name of fs.readdirSync(root).sort()) {
    if (name === '.DS_Store') continue
    const full = path.join(root, name)
    const rel = `${prefix}/${name}`
    const stat = fs.statSync(full)
    if (stat.isDirectory()) out.push(...treeEntries(full, rel))
    else if (stat.isFile()) out.push({ name: rel, data: fs.readFileSync(full), mode: modeOf(stat, rel) })
  }
  return out
}

/**
 * What the build VM unpacks into /opt/milibot-src: provision.sh with its steps and pinned versions, the
 * guest files, the guest agent bundle and the build info.
 */
export function payloadEntries(vmDir: string, agentBundle: string, buildInfo: object): TarEntry[] {
  const file = (name: string, mode: number) => ({
    name: `./${name}`,
    data: fs.readFileSync(path.join(vmDir, name)),
    mode,
  })
  return [
    file('provision.sh', 0o755),
    file('versions.env', 0o644),
    ...treeEntries(path.join(vmDir, 'provision.d'), './provision.d'),
    ...treeEntries(path.join(vmDir, 'guest'), './guest'),
    { name: './guest-agent.mjs', data: fs.readFileSync(agentBundle), mode: 0o644 },
    { name: './build-info.json', data: Buffer.from(JSON.stringify(buildInfo) + '\n'), mode: 0o644 },
  ]
}
