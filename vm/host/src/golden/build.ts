import { type ChildProcess, execFile, spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'

import { actualBytes, goldenFs, type HostProfile, sleep, whichSync, writeAtomic } from '../lib/host.ts'
import { baseQemuArgs, CLOUD_CONFIG_BASE } from '../lib/qemu.ts'
import {
  buildIso,
  type FirmwarePair,
  goldenFileName,
  type Host,
  launchWithFallback,
  parseGoldenRevision,
  resolveGoldenFile,
  VmLaunchExited,
  type VmProfile,
  type WhpxIrqchipChoice,
} from '../lib/shared.ts'
import { checksumFor, download, fetchText, sha512File } from './download.ts'
import { BuildError, log, utcVersion } from './log.ts'
import { payloadEntries, tarGz } from './payload-tar.ts'
import { publishGolden } from './publish.ts'
import { lastProvisionLine, parseSerial } from './serial.ts'

const execFileAsync = promisify(execFile)
const SYSTEM_DISK_GB = 40
/** A QEMU that exits this soon failed to start (e.g. WHPX missing) rather than finishing the build. */
const STARTUP_MS = 5000

export interface BuildOptions {
  rebuild: boolean
  cpus: number
  memGb: number
  timeoutMin: number
  keepWork: boolean
}

export interface BuildContext {
  host: Host
  vmDir: string
  imagesDir: string
  /** Scratch folder of the writable build disk. */
  buildRoot: string
  baseUrl: string
  irqchip: WhpxIrqchipChoice
  profile: HostProfile
}

function npm(args: string[], cwd: string): void {
  const win = process.platform === 'win32'
  const res = spawnSync(win ? 'npm.cmd' : 'npm', args, {
    cwd,
    stdio: ['ignore', 2, 2],
    shell: win,
    windowsHide: true,
  })
  if (res.status !== 0) throw new BuildError(`npm ${args.join(' ')} failed in ${cwd}`)
}

function bundleGuestAgent(vmDir: string): string {
  const dir = path.join(vmDir, 'guest-agent')
  // The packaged app ships only the prebuilt bundle (no sources to build from).
  if (fs.existsSync(path.join(dir, 'src'))) {
    log('bundling guest agent')
    const esbuild = path.join(
      dir,
      'node_modules',
      '.bin',
      process.platform === 'win32' ? 'esbuild.cmd' : 'esbuild',
    )
    if (!fs.existsSync(esbuild)) npm(['install', '--no-package-lock', '--no-audit', '--no-fund'], dir)
    npm(['run', '--silent', 'build'], dir)
  }
  const bundle = path.join(dir, 'dist', 'guest-agent.mjs')
  if (!fs.existsSync(bundle)) throw new BuildError('guest agent bundle not found')
  return bundle
}

function userData(runnerB64: string): string {
  return [
    '#cloud-config',
    ...CLOUD_CONFIG_BASE,
    'write_files:',
    '  - path: /usr/local/sbin/milibot-build-runner',
    "    permissions: '0755'",
    '    encoding: b64',
    `    content: ${runnerB64}`,
    'runcmd:',
    '  - [/usr/local/sbin/milibot-build-runner]',
    '',
  ].join('\n')
}

export function buildVmArgs(
  prof: VmProfile,
  fw: Pick<FirmwarePair, 'code'>,
  vm: { work: string; vars: string; seed: string; serial: string; cpus: number; memGb: number },
): string[] {
  return [
    ...baseQemuArgs(prof, fw, {
      name: 'milibot-golden-build',
      cpus: vm.cpus,
      memGb: vm.memGb,
      vars: vm.vars,
      disks: [{ id: 'sys', file: vm.work, serial: 'milisys' }],
      seed: vm.seed,
      serial: vm.serial,
    }),
    '-no-reboot',
  ]
}

type BuildExit = { code: number | null; signal: NodeJS.Signals | null } | { error: string }

/**
 * Spawns the build VM. Exiting within STARTUP_MS rejects with `VmLaunchExited` (QEMU's stderr tail), so
 * `launchWithFallback` can retry with TCG.
 */
async function launchBuildVm(
  prof: VmProfile,
  args: string[],
  onSpawn: (child: ChildProcess) => void,
): Promise<{ exit: Promise<BuildExit> }> {
  const qemu = spawn(prof.qemuBinary, args, { stdio: ['ignore', 'inherit', 'pipe'], windowsHide: true })
  onSpawn(qemu)
  let stderrTail = ''
  qemu.stderr.on('data', (chunk: Buffer) => {
    process.stderr.write(chunk)
    stderrTail = (stderrTail + chunk.toString('utf8')).slice(-4096)
  })
  const exit = new Promise<BuildExit>((resolve) => {
    qemu.on('close', (code, signal) => resolve({ code, signal }))
    qemu.on('error', (err) => resolve({ error: err.message }))
  })
  const early = await Promise.race([exit, sleep(STARTUP_MS).then(() => null)])
  if (early && 'error' in early) throw new BuildError(`could not run ${prof.qemuBinary}: ${early.error}`)
  if (early) {
    const how = early.signal ?? `code ${early.code}`
    throw new VmLaunchExited(`qemu exited during startup (${how}): ${stderrTail.trim()}`, stderrTail)
  }
  return { exit }
}

/** Downloads (or reuses) the Debian cloud image, checked against Debian's SHA512SUMS. */
async function baseImage(
  ctx: BuildContext,
  baseName: string,
  cacheDir: string,
): Promise<{ file: string; sha512: string }> {
  log('checking base image')
  const expected = checksumFor(await fetchText(`${ctx.baseUrl}/SHA512SUMS`), baseName)
  if (!expected) throw new BuildError(`no checksum for ${baseName}`)
  const cached = path.join(cacheDir, baseName)
  const actual = fs.existsSync(cached) ? await sha512File(cached) : ''
  if (actual !== expected) {
    log(`downloading ${baseName}`)
    const part = `${cached}.part`
    for (let attempt = 1; ; attempt++) {
      try {
        fs.rmSync(part, { force: true })
        const got = await download(`${ctx.baseUrl}/${baseName}`, part)
        if (got !== expected) throw new BuildError(`checksum mismatch for ${baseName}`)
        break
      } catch (err) {
        if ((err instanceof BuildError && /checksum/.test(err.message)) || attempt === 3) throw err
        log(`download failed (${(err as Error).message}); retrying`)
        await sleep(2000 * attempt)
      }
    }
    if (fs.existsSync(cached)) fs.chmodSync(cached, 0o644)
    fs.renameSync(part, cached)
  }
  fs.chmodSync(cached, 0o444)
  return { file: cached, sha512: expected }
}

/** Builds a new golden version (or prints the existing manifest); returns the manifest text for stdout. */
export async function buildGolden(ctx: BuildContext, opts: BuildOptions): Promise<string> {
  const prof = ctx.profile()
  const arch = prof.goldenArch
  const baseName = `debian-13-genericcloud-${arch}.qcow2`

  const existing = resolveGoldenFile(ctx.imagesDir, arch, goldenFs, ctx.host.platform)
  if (existing && !opts.rebuild) {
    log('golden image already exists (use --rebuild to build a new version)')
    const manifest = existing.replace(/\.qcow2$/, '.json')
    return fs.existsSync(manifest) ? fs.readFileSync(manifest, 'utf8') : '{}\n'
  }

  for (const bin of [prof.qemuBinary, prof.qemuImgBinary]) {
    if (!whichSync(bin)) throw new BuildError(`missing ${bin} (install QEMU)`)
  }
  const fw = prof.firmware.find((pair) => fs.existsSync(pair.code) && fs.existsSync(pair.vars))
  if (!fw)
    throw new BuildError(`UEFI firmware not found (tried ${prof.firmware.map((f) => f.code).join(', ')})`)
  let timeoutMin = opts.timeoutMin
  if (prof.slow) {
    timeoutMin *= 4
    log(`no hardware acceleration (${prof.slowReason}): the build runs emulated and takes much longer`)
  }

  const version = utcVersion()
  const revision = parseGoldenRevision(goldenFs.readFile(path.join(ctx.vmDir, 'golden-revision')) ?? '')
  const buildDir = path.join(ctx.buildRoot, `golden-${version}`)
  const goldenName = goldenFileName(version, arch)
  const manifestName = goldenName.replace(/\.qcow2$/, '.json')
  const golden = path.join(ctx.imagesDir, goldenName)
  const manifestFile = path.join(ctx.imagesDir, manifestName)
  // Versioned images are never overwritten: overlays point to them.
  if (fs.existsSync(golden) || fs.existsSync(manifestFile))
    throw new BuildError(`${goldenName} already exists; retry in a minute`)
  const logDir = path.join(ctx.imagesDir, 'logs')
  const cacheDir = path.join(ctx.imagesDir, 'cache')
  const serialLog = path.join(logDir, `build-${version}-${arch}.serial.log`)
  for (const dir of [cacheDir, buildDir, logDir]) fs.mkdirSync(dir, { recursive: true })
  const started = Date.now()

  const base = await baseImage(ctx, baseName, cacheDir)
  const agentBundle = bundleGuestAgent(ctx.vmDir)

  log('building seed')
  const buildInfo = {
    version,
    revision,
    arch,
    buildDate: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    base: { name: baseName, url: `${ctx.baseUrl}/${baseName}`, sha512: base.sha512 },
  }
  const runner = fs.readFileSync(path.join(ctx.vmDir, 'guest', 'build-runner.sh'))
  const seed = path.join(buildDir, 'seed.iso')
  fs.writeFileSync(
    seed,
    buildIso(
      [
        {
          name: 'meta-data',
          data: Buffer.from(`instance-id: milibot-golden-${version}\nlocal-hostname: milibot-golden\n`),
        },
        { name: 'user-data', data: Buffer.from(userData(runner.toString('base64'))) },
        { name: 'payload.tgz', data: tarGz(payloadEntries(ctx.vmDir, agentBundle, buildInfo)) },
      ],
      { volumeId: 'cidata' },
    ),
  )

  log(`preparing build disk (${SYSTEM_DISK_GB}G virtual)`)
  const work = path.join(buildDir, 'work.qcow2')
  const vars = path.join(buildDir, 'efi-vars.fd')
  await execFileAsync(
    prof.qemuImgBinary,
    ['create', '-q', '-f', 'qcow2', '-F', 'qcow2', '-b', base.file, work, `${SYSTEM_DISK_GB}G`],
    { windowsHide: true },
  )
  fs.copyFileSync(fw.vars, vars)
  fs.chmodSync(vars, 0o600)

  log(`booting build VM (${opts.cpus} vCPU, ${opts.memGb}G, ${prof.accelKind}); serial log: ${serialLog}`)
  fs.writeFileSync(serialLog, '')
  let qemu: ChildProcess | null = null
  const run: { exited: BuildExit | null } = { exited: null }
  const killQemu = () => {
    if (qemu && qemu.exitCode === null && qemu.signalCode === null) qemu.kill('SIGKILL')
  }
  process.on('exit', killQemu)
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    process.on(sig, () => {
      killQemu()
      process.exit(1)
    })
  }
  let launched
  try {
    launched = await launchWithFallback({
      irqchip: ctx.irqchip,
      profileFor: ctx.profile,
      launch: (attempt) =>
        launchBuildVm(
          attempt,
          buildVmArgs(attempt, fw, { work, vars, seed, serial: serialLog, ...opts }),
          (child) => {
            qemu = child
          },
        ),
      beforeRetry: (fallback) => log(`qemu exited during startup; retrying (${fallback})`),
    })
  } catch (err) {
    if (err instanceof VmLaunchExited) throw new BuildError(err.message)
    throw err
  }
  const exitPromise = launched.result.exit.then((result) => (run.exited = result))
  if (launched.fallback === 'tcg') {
    timeoutMin *= 4
    log(
      `no hardware acceleration (${launched.profile.slowReason}): the build runs emulated and takes much longer`,
    )
  }

  const deadline = Date.now() + timeoutMin * 60_000
  let lastLine: string | null = null
  while (!run.exited) {
    if (Date.now() > deadline) {
      killQemu()
      throw new BuildError(`build timed out after ${timeoutMin} minutes (see ${serialLog})`)
    }
    const line = lastProvisionLine(serialLog)
    if (line && line !== lastLine) {
      log(`guest: ${line.replace(/^.*?\] /, '')}`)
      lastLine = line
    }
    await Promise.race([exitPromise, sleep(5000)])
  }
  const exit = run.exited
  if ('error' in exit) throw new BuildError(`could not run ${prof.qemuBinary}: ${exit.error}`)

  const { rc, manifest: guestManifest } = parseSerial(fs.readFileSync(serialLog, 'latin1'))
  if (rc !== 0) {
    const how = rc === null && exit.signal ? `, QEMU killed by ${exit.signal}` : ''
    throw new BuildError(`provisioning failed (rc=${rc ?? 'none'}${how}); see ${serialLog}`)
  }
  if (!guestManifest) throw new BuildError(`guest manifest missing from ${serialLog}`)
  const bootDone = Date.now()

  log(`flattening into ${golden}`)
  const part = `${golden}.part`
  await execFileAsync(
    prof.qemuImgBinary,
    ['convert', '-O', 'qcow2', '-o', 'cluster_size=65536', work, part],
    {
      windowsHide: true,
    },
  )
  fs.renameSync(part, golden)
  fs.chmodSync(golden, 0o444)

  const finished = Date.now()
  const { stdout } = await execFileAsync(prof.qemuImgBinary, ['info', '--output=json', golden], {
    windowsHide: true,
  })
  const manifest = {
    ...guestManifest,
    arch,
    image: {
      file: goldenName,
      actualBytes: actualBytes(golden),
      virtualBytes: (JSON.parse(stdout) as { 'virtual-size': number })['virtual-size'],
    },
    buildSeconds: {
      total: Math.round((finished - started) / 1000),
      provision: Math.round((bootDone - started) / 1000),
    },
  }
  const manifestText = JSON.stringify(manifest, null, 2) + '\n'
  writeAtomic(manifestFile, manifestText)
  fs.chmodSync(manifestFile, 0o444)
  publishGolden(ctx.imagesDir, arch, goldenName)

  if (!opts.keepWork) fs.rmSync(buildDir, { recursive: true, force: true })

  log(`golden image ready in ${Math.round((finished - started) / 1000)}s`)
  return manifestText
}
