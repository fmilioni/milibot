#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { Arch, build, Platform } from 'electron-builder'

import { HostToolsError, installHostTools } from '../../vm/host/src/tools/host-tools.ts'
import { checkTarget, hasWine, PackageError, packagePaths, parseArgs, USAGE } from './args.mjs'
import { appPackageJson, buildConfig, windowsSigningNotice } from './config.mjs'
import { resolveNatives } from './natives.mjs'
import { nodeBinary } from './node-runtime.mjs'

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'))

function stageApp({ stage, desktop }, rootPackage) {
  rmSync(stage, { recursive: true, force: true })
  const app = join(stage, 'app')
  mkdirSync(app, { recursive: true })
  writeFileSync(join(app, 'package.json'), JSON.stringify(appPackageJson(rootPackage), null, 2))
  cpSync(join(desktop, 'out'), join(app, 'out'), { recursive: true })
  writeFileSync(join(stage, 'daemon-package.json'), JSON.stringify({ type: 'module', private: true }))
  return app
}

/** Electron's binary (the `electronDist` of a native build) is downloaded on demand, not on install. */
function ensureElectron({ desktop }) {
  const result = spawnSync(process.execPath, [join(desktop, 'node_modules/electron/install.js')], {
    stdio: 'inherit',
    windowsHide: true,
  })
  if (result.status !== 0) throw new PackageError('downloading the Electron binary failed')
}

/** The VM CLIs (vm/host) import shared code from packages/: bundled into single files in Resources/vm/scripts. */
async function bundleVmScripts({ root, daemon, stage }) {
  const { build: esbuild } = await import(
    pathToFileURL(createRequire(join(daemon, 'package.json')).resolve('esbuild')).href
  )
  const out = join(stage, 'vm-scripts')
  await esbuild({
    entryPoints: [
      join(root, 'vm/host/src/cli/workspace-vm.ts'),
      join(root, 'vm/host/src/cli/build-golden.ts'),
    ],
    outdir: out,
    outExtension: { '.js': '.mjs' },
    bundle: true,
    platform: 'node',
    target: 'node24',
    format: 'esm',
    logLevel: 'warning',
  })
  return out
}

/** The target's gvproxy (and the other pinned host programs), shipped in Resources/vm/bin. */
async function stageHostTools({ platform, arch, stage }) {
  const dest = join(stage, 'vm-bin')
  try {
    await installHostTools({ platform, arch, dest, log: (message) => console.log(`package: ${message}`) })
  } catch (err) {
    if (err instanceof HostToolsError) throw new PackageError(err.message)
    throw err
  }
  return dest
}

function targets({ platform, arch, dirOnly }) {
  const archOf = arch === 'x64' ? Arch.x64 : Arch.arm64
  if (platform === 'darwin') return Platform.MAC.createTarget(dirOnly ? ['dir'] : ['dmg'], archOf)
  if (platform === 'win32') return Platform.WINDOWS.createTarget(dirOnly ? ['dir'] : ['nsis'], archOf)
  return Platform.LINUX.createTarget(dirOnly ? ['dir'] : ['AppImage', 'deb'], archOf)
}

async function main() {
  const args = parseArgs(process.argv.slice(2), process.env)
  if (args.help) {
    console.log(USAGE)
    return
  }
  const ctx = { ...args, ...packagePaths(), env: process.env }
  const rootPackage = readJson(join(ctx.root, 'package.json'))
  const electronVersion = readJson(join(ctx.desktop, 'node_modules/electron/package.json')).version
  checkTarget(ctx)

  console.log(`package: Milibot ${rootPackage.version} (Electron ${electronVersion})`)
  if (!ctx.cross) ensureElectron(ctx)
  const { node, nodeVersion } = await nodeBinary(ctx)
  console.log(`package: bundling Node ${nodeVersion} from ${node}`)

  // pnpm is a .cmd shim on Windows: only a shell runs it.
  const buildResult = spawnSync('pnpm', ['build'], {
    cwd: ctx.root,
    stdio: 'inherit',
    shell: ctx.platform === 'win32',
    windowsHide: true,
  })
  if (buildResult.status !== 0) throw new PackageError('pnpm build failed')
  for (const file of [
    join(ctx.desktop, 'out/main/index.js'),
    join(ctx.daemon, 'dist/main.js'),
    join(ctx.daemon, 'dist/runtime-main.js'),
    join(ctx.daemon, 'dist/embedding-worker.js'),
    join(ctx.root, 'vm/guest-agent/dist/guest-agent.mjs'),
  ]) {
    if (!existsSync(file)) throw new PackageError(`missing build output ${file}`)
  }

  const appDir = stageApp(ctx, rootPackage)
  const vmScripts = await bundleVmScripts(ctx)
  const vmBin = await stageHostTools(ctx)
  const natives = resolveNatives(ctx)
  const config = buildConfig({
    ctx,
    electronVersion,
    appDir,
    node,
    vmScripts,
    vmBin,
    natives,
    skipExecutableEdit: ctx.platform === 'win32' && process.platform !== 'win32' && !hasWine(),
  })

  windowsSigningNotice(ctx, config)
  try {
    const artifacts = await build({ projectDir: ctx.root, targets: targets(ctx), config })
    for (const artifact of artifacts) {
      console.log(`package: ${artifact} (${(statSync(artifact).size / 1024 ** 2).toFixed(1)} MB)`)
    }
    const { platform, arch, distDir } = ctx
    const unpacked =
      platform === 'darwin'
        ? join(distDir, 'mac-arm64', 'Milibot.app')
        : join(
            distDir,
            `${platform === 'win32' ? 'win' : 'linux'}${arch === 'arm64' ? '-arm64' : ''}-unpacked`,
          )
    console.log(`package: app at ${unpacked}`)
  } finally {
    rmSync(ctx.stage, { recursive: true, force: true })
  }
}

try {
  await main()
} catch (err) {
  if (!(err instanceof PackageError)) throw err
  console.error(`package: ${err.message}`)
  process.exit(1)
}
