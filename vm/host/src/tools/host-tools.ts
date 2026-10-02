// Host programs the VM scripts run besides Node, pinned per platform and checked by sha256: they go to
// `vm/bin/` (`pnpm vm:tools`) and, for the target platform, into the packaged app's `Resources/vm/bin/`.
// gvproxy comes from its upstream release; QEMU from this repo's qemu-<version>-<build> release, built by
// .github/workflows/qemu.yml, whose SHA256SUMS is copied to vm/qemu/SHA256SUMS.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { executableName } from '../lib/shared.ts'

interface PinnedAsset {
  file: string
  sha256: string
}

const GVPROXY_VERSION = 'v0.8.9'
const GVPROXY_BASE = `https://github.com/containers/gvisor-tap-vsock/releases/download/${GVPROXY_VERSION}`
const GVPROXY_DARWIN: PinnedAsset = {
  file: 'gvproxy-darwin',
  sha256: 'c6f7b4bc7f21bf810b5cf54e04d979b014c5d96472a03a9e97fe62a00940067c',
}
const GVPROXY_ASSETS: Record<string, PinnedAsset> = {
  'darwin-arm64': GVPROXY_DARWIN,
  'darwin-x64': GVPROXY_DARWIN,
  'linux-x64': {
    file: 'gvproxy-linux-amd64',
    sha256: '3011c5629c9138d2050fb23c510e09ae53e30ec52e6a9ab85632bc1550e8ef63',
  },
  'linux-arm64': {
    file: 'gvproxy-linux-arm64',
    sha256: '6ecca02839254c9a0cc184bba7aac63755a22d7ed10d455b852528a99d7f7d4b',
  },
  'win32-x64': {
    file: 'gvproxy-windows.exe',
    sha256: 'a3b6915d8a976f5ed2bbba727af52c90c55b9d5e85f680b584c8a1c5d6b546bc',
  },
  'win32-arm64': {
    file: 'gvproxy-arm64.exe',
    sha256: 'd93a115486511233e449572db7e258abcd015f39b49f2c6e3ffa6e363949f3b2',
  },
}

const QEMU_PINS = fileURLToPath(new URL('../../../qemu/', import.meta.url))
const QEMU_RELEASES = 'https://github.com/fmilioni/milibot/releases/download'

export class HostToolsError extends Error {}

function readPins(file: string): string {
  try {
    return fs.readFileSync(path.join(QEMU_PINS, file), 'utf8')
  } catch {
    throw new HostToolsError(`vm/qemu/${file} is missing`)
  }
}

/** The QEMU package of a target: `vm/qemu/version.env` names it, `vm/qemu/SHA256SUMS` pins it. */
function qemuPackage(platform: string, arch: string): PinnedAsset & { url: string } {
  const env = Object.fromEntries(
    readPins('version.env')
      .split('\n')
      .map((line) => /^([A-Z_]+)=(.*)$/.exec(line.trim()))
      .filter((match) => match !== null)
      .map((match) => [match[1], match[2]]),
  )
  const tag = `qemu-${env.QEMU_VERSION}-${env.QEMU_BUILD}`
  const file = `${tag}-${platform}-${arch}.tar.gz`
  const sha256 = readPins('SHA256SUMS')
    .split('\n')
    .map((line) => line.trim().split(/\s+/))
    .find(([, name]) => name === file)?.[0]
  if (!sha256) throw new HostToolsError(`no QEMU package for ${platform}-${arch} in vm/qemu/SHA256SUMS`)
  return { file, sha256, url: `${QEMU_RELEASES}/${tag}/${file}` }
}

function sha256(file: string): string | null {
  try {
    return createHash('sha256').update(fs.readFileSync(file)).digest('hex')
  } catch {
    return null
  }
}

async function fetchVerified(url: string, dest: string, expected: string): Promise<void> {
  const res = await fetch(url, { signal: AbortSignal.timeout(300_000) })
  if (!res.ok) throw new HostToolsError(`GET ${url} -> HTTP ${res.status}`)
  const data = Buffer.from(await res.arrayBuffer())
  const actual = createHash('sha256').update(data).digest('hex')
  if (actual !== expected) throw new HostToolsError(`checksum mismatch for ${url}`)
  const part = `${dest}.part-${process.pid}`
  fs.writeFileSync(part, data, { mode: 0o755 })
  fs.renameSync(part, dest)
}

export interface HostToolsTarget {
  platform: string
  arch: string
  /** Folder that receives the programs (`vm/bin`, or the package's staging folder). */
  dest: string
  log?: (message: string) => void
}

/** Unpacks the target's QEMU into `dest/qemu`; `.package` there records which tarball it came from. */
async function installQemu(platform: string, arch: string, dest: string, log: (message: string) => void) {
  const pkg = qemuPackage(platform, arch)
  const home = path.join(dest, 'qemu')
  const stamp = path.join(home, '.package')
  const want = `${pkg.file} ${pkg.sha256}\n`
  if (fs.existsSync(stamp) && fs.readFileSync(stamp, 'utf8') === want) return
  log(`downloading ${pkg.file}`)
  const tarball = path.join(dest, pkg.file)
  await fetchVerified(pkg.url, tarball, pkg.sha256)
  const fresh = `${home}.new`
  fs.rmSync(fresh, { recursive: true, force: true })
  fs.mkdirSync(fresh)
  // Relative names: GNU tar (Git Bash on Windows) reads `D:\…` as a remote `host:file`.
  execFileSync('tar', ['-xzf', pkg.file, '-C', path.basename(fresh)], {
    cwd: dest,
    stdio: 'inherit',
    windowsHide: true,
  })
  fs.writeFileSync(path.join(fresh, '.package'), want)
  fs.rmSync(home, { recursive: true, force: true })
  fs.renameSync(fresh, home)
  fs.rmSync(tarball, { force: true })
}

/**
 * Puts this target's gvproxy and QEMU in `dest` (`gvproxy`, `qemu/`); what is already there with the pinned
 * checksum is kept.
 */
export async function installHostTools({
  platform,
  arch,
  dest,
  log = () => {},
}: HostToolsTarget): Promise<void> {
  const asset = GVPROXY_ASSETS[`${platform}-${arch}`]
  if (!asset) throw new HostToolsError(`no gvproxy build for ${platform}-${arch}`)
  fs.mkdirSync(dest, { recursive: true })
  const file = path.join(dest, executableName('gvproxy', platform))
  if (sha256(file) !== asset.sha256) {
    log(`downloading gvproxy ${GVPROXY_VERSION} (${asset.file})`)
    await fetchVerified(`${GVPROXY_BASE}/${asset.file}`, file, asset.sha256)
  }
  await installQemu(platform, arch, dest, log)
}
