import type { GoldenBuildStage } from '@milibot/shared'

/**
 * Progress of the golden build, read from its output: its own `[build HH:MM:SS] …` lines, a curl-style meter
 * while the Debian base downloads (`\r`-separated) and the guest's provisioning steps, relayed as
 * `[build …] guest: <line>`.
 */
export interface BuildProgress {
  stage: GoldenBuildStage | null
  /** 0–1 inside the current stage. */
  stageFraction: number
  downloadBytes: number | null
  /** curl's "Time Left" of the download. */
  downloadLeftSeconds: number | null
  finished: boolean
  error: string | null
}

export const INITIAL_BUILD_PROGRESS: BuildProgress = {
  stage: null,
  stageFraction: 0,
  downloadBytes: null,
  downloadLeftSeconds: null,
  finished: false,
  error: null,
}

/** Share of the whole build of each stage (percent at its start and end). */
const STAGE_SPAN: Record<GoldenBuildStage, [number, number]> = {
  download: [0, 30],
  install: [30, 88],
  save: [88, 100],
}

/** Typical seconds of the steps after the download. */
export const INSTALL_SECONDS = 110
export const SAVE_SECONDS = 30

/** `vm/provision.d` steps in order with their typical seconds. */
const PROVISION_STEPS: Array<[name: string, seconds: number]> = [
  ['apt-jobs', 1],
  ['users', 1],
  ['base-packages', 56],
  ['locale', 1],
  ['apt-repos', 2],
  ['docker-gh-node', 5],
  ['browser', 7],
  ['go', 3],
  ['rust', 5],
  ['uv', 1],
  ['claude-code', 9],
  ['system-config', 1],
  ['milibot-components', 1],
  ['manifest', 1],
]
export const PROVISION_STEP_NAMES = PROVISION_STEPS.map(([name]) => name)
const PROVISION_TOTAL = PROVISION_STEPS.reduce((sum, [, s]) => sum + s, 0)
/** Part of the install stage spent before the guest starts provisioning (seed, disk, boot). */
const INSTALL_BOOT_SHARE = 0.12

const UNITS: Record<string, number> = { '': 1, k: 1024, K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4 }

export function parseCurlSize(text: string): number | null {
  const match = /^([\d.]+)([kKMGT]?)$/.exec(text)
  if (!match) return null
  const value = Number(match[1])
  return Number.isFinite(value) ? Math.round(value * (UNITS[match[2] ?? ''] ?? 1)) : null
}

function parseClock(text: string): number | null {
  const match = /^(\d+):(\d{2}):(\d{2})$/.exec(text)
  return match ? Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) : null
}

/** One refresh of curl's meter: `% Total % Received % Xferd Avg-Dload Avg-Upload Total Spent Left Speed`. */
export function parseCurlMeter(
  line: string,
): { percent: number; totalBytes: number | null; leftSeconds: number | null } | null {
  const cols = line.trim().split(/\s+/)
  if (cols.length < 12 || !/^\d{1,3}$/.test(cols[0] ?? '')) return null
  const percent = Number(cols[0])
  if (percent > 100) return null
  const left = cols[10] ?? ''
  return {
    percent,
    totalBytes: parseCurlSize(cols[1] ?? ''),
    leftSeconds: parseClock(left),
  }
}

/** Share of the provisioning done when step `index` (0-based) of the known list starts. */
function knownStepFraction(index: number): number {
  return PROVISION_STEPS.slice(0, index).reduce((sum, [, s]) => sum + s, 0) / PROVISION_TOTAL
}

/** `[provision step 3/14 base-packages]` (the brackets or the `provision ` word may be stripped). */
const STEP_LINE = /^\[?(?:provision )?step (\d+)\/(\d+) ([^\]\s]+)\]?$/

/**
 * Share of the provisioning done at a relayed guest line: a numbered step weighs by the typical durations
 * when the log's list is the known one, else by its position.
 */
function provisionFraction(line: string): number {
  const step = STEP_LINE.exec(line)
  if (step) {
    const index = Number(step[1]) - 1
    const total = Number(step[2])
    if (!(total > 0 && index >= 0 && index < total)) return -1
    const known = total === PROVISION_STEPS.length && PROVISION_STEPS[index]?.[0] === step[3]
    return known ? knownStepFraction(index) : index / total
  }
  return line.startsWith('done') ? 1 : -1
}

function installFraction(line: string): number {
  const fraction = provisionFraction(line)
  return fraction < 0 ? -1 : INSTALL_BOOT_SHARE + (1 - INSTALL_BOOT_SHARE) * fraction
}

function applyLine(progress: BuildProgress, raw: string): BuildProgress {
  const line = raw.trim()
  if (!line) return progress
  const built = /^\[build [\d:]+\] (.*)$/.exec(line)
  if (!built) {
    const meter = progress.stage === 'download' ? parseCurlMeter(line) : null
    if (!meter) return progress
    return {
      ...progress,
      stageFraction: Math.max(progress.stageFraction, meter.percent / 100),
      downloadBytes: meter.totalBytes ?? progress.downloadBytes,
      downloadLeftSeconds: meter.leftSeconds,
    }
  }
  const message = built[1] ?? ''
  const at = (stage: GoldenBuildStage, fraction: number): BuildProgress => ({
    ...progress,
    stage,
    stageFraction: progress.stage === stage ? Math.max(progress.stageFraction, fraction) : fraction,
    ...(stage === 'download' ? {} : { downloadLeftSeconds: null }),
  })
  if (message.startsWith('ERROR: ')) return { ...progress, error: message.slice('ERROR: '.length) }
  if (message.startsWith('golden image already exists') || message.startsWith('golden image ready'))
    return { ...at('save', 1), finished: true }
  if (message.startsWith('checking base image') || message.startsWith('downloading '))
    return at('download', 0)
  if (message.startsWith('bundling guest agent')) return at('install', 0)
  if (message.startsWith('building seed')) return at('install', 0.02)
  if (message.startsWith('preparing build disk')) return at('install', 0.04)
  if (message.startsWith('booting build VM')) return at('install', 0.06)
  if (message.startsWith('guest: ')) {
    const fraction = installFraction(message.slice('guest: '.length))
    return fraction >= 0 ? at('install', fraction) : progress
  }
  if (message.startsWith('flattening into')) return at('save', 0)
  return progress
}

/** Folds a chunk of build output (lines split on `\n` or curl's `\r`) into the progress. */
export function applyBuildOutput(progress: BuildProgress, chunk: string): BuildProgress {
  return chunk.split(/\r\n|\r|\n/).reduce(applyLine, progress)
}

/** 0–100 of the whole build. */
export function buildPercent(progress: BuildProgress): number {
  if (progress.finished) return 100
  if (!progress.stage) return 0
  const [start, end] = STAGE_SPAN[progress.stage]
  return Math.round(start + (end - start) * Math.min(1, Math.max(0, progress.stageFraction)))
}

/** Seconds left: curl's estimate for the download, typical durations for the rest. */
export function buildEtaSeconds(progress: BuildProgress): number | null {
  if (progress.finished) return 0
  switch (progress.stage) {
    case null:
      return null
    case 'download':
      return progress.downloadLeftSeconds === null
        ? null
        : progress.downloadLeftSeconds + INSTALL_SECONDS + SAVE_SECONDS
    case 'install':
      return Math.round((1 - progress.stageFraction) * INSTALL_SECONDS) + SAVE_SECONDS
    case 'save':
      return Math.round((1 - progress.stageFraction) * SAVE_SECONDS)
  }
}
