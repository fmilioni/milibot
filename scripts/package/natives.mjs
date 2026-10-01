import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

import { PackageError } from './args.mjs'
import { binaryArch } from './node-runtime.mjs'

// The binding loads the runtime library from its own directory (no CUDA/DirectML-only extras on Linux).
const ONNX_LIBS = {
  darwin: ['libonnxruntime.1.dylib'],
  linux: ['libonnxruntime.so.1'],
  win32: ['onnxruntime.dll', 'DirectML.dll', 'dxcompiler.dll', 'dxil.dll'],
}

/**
 * Cross-build: the keyring's addon for the target is an optional dependency pnpm skipped on this host;
 * fetched with `npm pack` at the version the installed `@napi-rs/keyring` pins.
 */
function packedKeyringNative(cache, keyring, name) {
  const version = JSON.parse(readFileSync(join(keyring, 'package.json'), 'utf8')).optionalDependencies?.[name]
  if (!version) throw new PackageError(`@napi-rs/keyring does not list ${name}`)
  const dir = join(cache, `${name.replace('/', '+')}-${version}`)
  if (!existsSync(join(dir, 'package', 'package.json'))) {
    mkdirSync(dir, { recursive: true })
    const packed = execFileSync(
      'npm',
      ['pack', `${name}@${version}`, '--silent', '--pack-destination', dir],
      {
        encoding: 'utf8',
        windowsHide: true,
      },
    )
      .trim()
      .split('\n')
      .pop()
    execFileSync('tar', ['-xzf', join(dir, packed), '-C', dir], { windowsHide: true })
  }
  return join(dir, 'package')
}

/** Linux/Windows keep secrets in the OS keyring through @napi-rs/keyring (macOS uses the security CLI). */
function keyringNative({ platform, arch, cross, daemon, cache }) {
  if (platform === 'darwin') return null
  const keyring = realpathSync(join(daemon, 'node_modules/@napi-rs/keyring'))
  const suffix = platform === 'linux' ? `${platform}-${arch}-gnu` : `${platform}-${arch}-msvc`
  let native
  try {
    native = dirname(
      createRequire(join(keyring, 'package.json')).resolve(`@napi-rs/keyring-${suffix}/package.json`),
    )
  } catch {
    if (!cross)
      throw new PackageError(`@napi-rs/keyring-${suffix} is not installed (pnpm install on this platform)`)
    native = packedKeyringNative(cache, keyring, `@napi-rs/keyring-${suffix}`)
  }
  const addon = join(native, `keyring.${suffix}.node`)
  if (!existsSync(addon)) throw new PackageError(`${addon} is missing`)
  if (binaryArch(addon) !== arch) throw new PackageError(`${addon} is not ${arch}`)
  return { keyring, native, suffix }
}

/** The daemon's native addons and assets for the target, checked to exist before packaging. */
export function resolveNatives(ctx) {
  const { platform, arch, daemon } = ctx
  const betterSqlite = realpathSync(join(daemon, 'node_modules/better-sqlite3'))
  const onnxNode = realpathSync(join(daemon, 'node_modules/onnxruntime-node'))
  const onnxCommon = realpathSync(join(daemon, 'node_modules/onnxruntime-common'))
  const onnxBin = `bin/napi-v6/${platform}/${arch}`
  const onnxLibs = ONNX_LIBS[platform]
  const tailwindDir = realpathSync(join(daemon, 'node_modules/tailwindcss'))
  const interDir = realpathSync(join(daemon, 'node_modules/@fontsource-variable/inter'))
  for (const file of ['onnxruntime_binding.node', ...onnxLibs]) {
    if (!existsSync(join(onnxNode, onnxBin, file)))
      throw new PackageError(`onnxruntime-node has no ${onnxBin}/${file}`)
  }
  const sqlitePrebuild = `prebuilds/${platform}-${arch}.node`
  if (!existsSync(join(betterSqlite, sqlitePrebuild)))
    throw new PackageError(`better-sqlite3 has no ${sqlitePrebuild}`)
  return {
    betterSqlite,
    sqlitePrebuild,
    onnxNode,
    onnxCommon,
    onnxBin,
    onnxLibs,
    tailwindDir,
    interDir,
    keyring: keyringNative(ctx),
  }
}
