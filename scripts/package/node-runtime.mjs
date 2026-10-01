import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { PackageError } from './args.mjs'

/** Downloads `url` into the package cache once (reused by later runs), checking its sha256 when given. */
async function download(cache, url, file, sha256) {
  const path = join(cache, file)
  const ok = () => !sha256 || createHash('sha256').update(readFileSync(path)).digest('hex') === sha256
  if (existsSync(path) && ok()) return path
  mkdirSync(cache, { recursive: true })
  console.log(`package: downloading ${url}`)
  const res = await fetch(url)
  if (!res.ok) throw new PackageError(`download failed: ${url} (${res.status})`)
  writeFileSync(path, Buffer.from(await res.arrayBuffer()))
  if (!ok()) throw new PackageError(`checksum mismatch for ${url}`)
  return path
}

/**
 * Cross-build: the official Node for Windows x64, same version as the Node running this script (checked
 * against nodejs.org's SHASUMS256.txt); `MILIBOT_PACKAGE_NODE` may point to a node.exe instead.
 */
async function windowsNode(cache) {
  const version = `v${process.versions.node}`
  const base = `https://nodejs.org/dist/${version}`
  const zipName = `node-${version}-win-x64.zip`
  const sums = await (await fetch(`${base}/SHASUMS256.txt`)).text()
  const sha = sums
    .split('\n')
    .find((line) => line.endsWith(`  ${zipName}`))
    ?.split(' ')[0]
  if (!sha) throw new PackageError(`${zipName} is not listed in ${base}/SHASUMS256.txt`)
  const zip = await download(cache, `${base}/${zipName}`, zipName, sha)
  const dir = join(cache, `node-${version}-win-x64`)
  const exe = join(dir, 'node.exe')
  if (!existsSync(exe)) {
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      exe,
      execFileSync('unzip', ['-p', zip, `node-${version}-win-x64/node.exe`], {
        maxBuffer: 512 * 1024 ** 2,
        windowsHide: true,
      }),
    )
  }
  return { node: exe, nodeVersion: version }
}

/** Architecture of an executable from its header (ELF, Mach-O or PE), without lipo/file. */
export function binaryArch(file) {
  const head = readFileSync(file).subarray(0, 4096)
  if (head.readUInt32BE(0) === 0x7f454c46) {
    const machine = head.readUInt16LE(18)
    return machine === 0x3e ? 'x64' : machine === 0xb7 ? 'arm64' : `elf-${machine}`
  }
  const magic = head.readUInt32LE(0)
  if (magic === 0xfeedfacf) {
    const cpu = head.readUInt32LE(4)
    return cpu === 0x0100000c ? 'arm64' : cpu === 0x01000007 ? 'x64' : `macho-${cpu}`
  }
  if (head.readUInt32BE(0) === 0xcafebabe) return 'universal'
  if (head.readUInt16LE(0) === 0x5a4d) {
    const pe = head.readUInt32LE(0x3c)
    const machine = head.readUInt16LE(pe + 4)
    return machine === 0x8664 ? 'x64' : machine === 0xaa64 ? 'arm64' : `pe-${machine}`
  }
  return 'unknown'
}

/** Shared libraries a Linux binary links besides glibc/libstdc++ (e.g. a distro Node's libnode.so). */
function foreignLinuxLibs(file) {
  const allowed =
    /^(linux-vdso|ld-linux[\w.-]*|libc|libm|libdl|libpthread|librt|libgcc_s|libstdc\+\+|libatomic|libresolv)\.so/
  return execFileSync('ldd', [file], { encoding: 'utf8', windowsHide: true })
    .split('\n')
    .map((line) => line.trim().split(/\s+/)[0] ?? '')
    .filter((lib) => lib && !allowed.test(lib.split('/').pop() ?? ''))
}

/**
 * The daemon runs under a Node shipped in Resources. It must be a standalone official build
 * (nvm/nodejs.org: only system libraries; not Homebrew's or a distro's, which link libnode/openssl),
 * of the target architecture, same major as the one the daemon is tested with.
 */
export async function nodeBinary({ platform, arch, cross, env, cache }) {
  if (cross && !env.MILIBOT_PACKAGE_NODE) {
    if (!process.version.startsWith('v24.'))
      throw new PackageError(`run the cross-build on Node 24 (this is ${process.version})`)
    return windowsNode(cache)
  }
  const node = realpathSync(env.MILIBOT_PACKAGE_NODE ?? process.execPath)
  const nodeArch = binaryArch(node)
  if (nodeArch !== arch)
    throw new PackageError(`${node} is a ${nodeArch} binary, the package is ${platform}-${arch}`)
  if (cross) {
    // A node.exe cannot run here: only its name tells the version.
    const version = /v24\.[\d.]+/.exec(node)?.[0]
    if (!version)
      throw new PackageError(
        `${node}: name the folder after its version (node-v24.x.y-win-x64) or cross-build without it`,
      )
    return { node, nodeVersion: version }
  }
  let foreign = []
  if (platform === 'darwin') {
    foreign = execFileSync('otool', ['-L', node], { encoding: 'utf8' })
      .split('\n')
      .slice(1)
      .map((line) => line.trim().split(' ')[0])
      .filter((lib) => lib && !lib.startsWith('/usr/lib/') && !lib.startsWith('/System/'))
  } else if (platform === 'linux') {
    foreign = foreignLinuxLibs(node)
  }
  if (foreign.length > 0)
    throw new PackageError(
      `${node} links ${foreign.join(', ')}; use an official Node build (nvm) or set MILIBOT_PACKAGE_NODE`,
    )
  const nodeVersion = execFileSync(node, ['-v'], { encoding: 'utf8', windowsHide: true }).trim()
  if (!nodeVersion.startsWith('v24.'))
    throw new PackageError(`${node} is ${nodeVersion}; the daemon needs Node 24`)
  return { node, nodeVersion }
}
