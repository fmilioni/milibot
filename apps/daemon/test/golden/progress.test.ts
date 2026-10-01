import { readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import {
  applyBuildOutput,
  buildEtaSeconds,
  buildPercent,
  INITIAL_BUILD_PROGRESS,
  INSTALL_SECONDS,
  parseCurlMeter,
  parseCurlSize,
  PROVISION_STEP_NAMES,
  SAVE_SECONDS,
} from '../../src/golden/progress'

const CURL_HEADER =
  '  % Total    % Received % Xferd  Average Speed   Time    Time     Time  Current\n' +
  '                                 Dload  Upload   Total   Spent    Left  Speed\n'

describe('golden build progress', () => {
  it('parses curl sizes and meter refreshes', () => {
    expect(parseCurlSize('412M')).toBe(412 * 1024 ** 2)
    expect(parseCurlSize('1.5G')).toBe(Math.round(1.5 * 1024 ** 3))
    expect(parseCurlSize('0')).toBe(0)
    expect(parseCurlSize('--:--')).toBeNull()
    expect(
      parseCurlMeter(' 45  412M   45  185M    0     0  20.1M      0  0:00:20  0:00:09  0:00:11 21.3M'),
    ).toEqual({
      percent: 45,
      totalBytes: 412 * 1024 ** 2,
      leftSeconds: 11,
    })
    expect(
      parseCurlMeter('  0     0    0     0    0     0      0      0 --:--:-- --:--:-- --:--:--     0'),
    ).toEqual({
      percent: 0,
      totalBytes: 0,
      leftSeconds: null,
    })
    expect(parseCurlMeter('[build 10:00:00] booting build VM')).toBeNull()
  })

  it('follows the download through curl carriage returns', () => {
    let p = applyBuildOutput(INITIAL_BUILD_PROGRESS, '[build 13:20:01] checking base image\n')
    expect(p.stage).toBe('download')
    expect(buildPercent(p)).toBe(0)
    p = applyBuildOutput(p, '[build 13:20:02] downloading debian-13-genericcloud-arm64.qcow2\n' + CURL_HEADER)
    p = applyBuildOutput(
      p,
      '\r  10  412M   10 41.2M    0     0  20.0M      0  0:00:20  0:00:02  0:00:18 20.0M' +
        '\r  50  412M   50  206M    0     0  20.0M      0  0:00:20  0:00:10  0:00:10 20.0M',
    )
    expect(p.downloadBytes).toBe(412 * 1024 ** 2)
    expect(buildPercent(p)).toBe(15)
    expect(buildEtaSeconds(p)).toBe(10 + INSTALL_SECONDS + SAVE_SECONDS)
  })

  it('maps provisioning steps and the flattening onto the whole build', () => {
    let p = applyBuildOutput(
      INITIAL_BUILD_PROGRESS,
      [
        '[build 13:20:01] checking base image',
        '[build 13:20:02] bundling guest agent',
        'added 3 packages in 2s',
        '[build 13:20:05] building seed',
        '[build 13:20:06] preparing build disk (40G virtual)',
        '[build 13:20:06] booting build VM (8 vCPU, 8G); serial log: /x/serial.log',
      ].join('\n'),
    )
    expect(p.stage).toBe('install')
    const booted = buildPercent(p)
    expect(booted).toBeGreaterThan(30)
    const n = PROVISION_STEP_NAMES.length
    p = applyBuildOutput(p, `[build 13:20:30] guest: [provision step 3/${n} base-packages]\n`)
    const basePackages = buildPercent(p)
    p = applyBuildOutput(p, `[build 13:21:30] guest: [provision step 11/${n} claude-code]\n`)
    expect(buildPercent(p)).toBeGreaterThan(basePackages)
    expect(basePackages).toBeGreaterThan(booted)
    expect(buildEtaSeconds(p)).toBeLessThan(INSTALL_SECONDS + SAVE_SECONDS)
    // An unknown guest line or retry keeps the position.
    expect(buildPercent(applyBuildOutput(p, '[build 13:21:31] guest: retry 1: apt-get update\n'))).toBe(
      buildPercent(p),
    )
    p = applyBuildOutput(p, '[build 13:22:00] flattening into /images/debian13-golden-1-arm64.qcow2\n')
    expect(p.stage).toBe('save')
    expect(buildPercent(p)).toBe(88)
    expect(buildEtaSeconds(p)).toBe(SAVE_SECONDS)
    p = applyBuildOutput(p, '[build 13:22:30] golden image ready in 149s\n')
    expect(p.finished).toBe(true)
    expect(buildPercent(p)).toBe(100)
    expect(buildEtaSeconds(p)).toBe(0)
  })

  it('follows numbered provisioning steps', () => {
    const booted = applyBuildOutput(INITIAL_BUILD_PROGRESS, '[build 1:00:00] booting build VM\n')
    const n = PROVISION_STEP_NAMES.length
    const at = (line: string) => buildPercent(applyBuildOutput(booted, `[build 1:00:10] guest: ${line}\n`))
    const base = at(`[provision step 3/${n} base-packages]`)
    expect(base).toBeGreaterThan(buildPercent(booted))
    expect(at(`[provision step 4/${n} locale]`)).toBeGreaterThan(base + 20)
    expect(at(`step 4/${n} locale`)).toBe(at(`[provision step 4/${n} locale]`))
    // A list this version doesn't know goes by position.
    expect(at('[provision step 5/10 something-new]')).toBe(at('[provision step 3/5 other]'))
    expect(at('[provision step 1/10 other]')).toBeLessThan(at('[provision step 6/10 other]'))
    expect(at('[provision step 11/10 other]')).toBe(buildPercent(booted))
    expect(at('done')).toBe(88)
  })

  it('knows every step of vm/provision.d in order', () => {
    const dir = fileURLToPath(new URL('../../../../vm/provision.d', import.meta.url))
    const steps = readdirSync(dir)
      .filter((f) => f.endsWith('.sh'))
      .sort()
      .map((f) => f.replace(/^\d+-/, '').replace(/\.sh$/, ''))
    expect(steps).toEqual(PROVISION_STEP_NAMES)
  })

  it('never moves backwards inside a stage and keeps the error', () => {
    const n = PROVISION_STEP_NAMES.length
    let p = applyBuildOutput(
      INITIAL_BUILD_PROGRESS,
      `[build 1:00:00] booting build VM\n[build 1:00:10] guest: [provision step 8/${n} go]\n`,
    )
    const before = buildPercent(p)
    p = applyBuildOutput(p, `[build 1:00:11] guest: [provision step 3/${n} base-packages]\n`)
    expect(buildPercent(p)).toBe(before)
    p = applyBuildOutput(p, '[build 1:00:12] ERROR: provisioning failed (rc=1); see /x/serial.log\n')
    expect(p.error).toBe('provisioning failed (rc=1); see /x/serial.log')
  })

  it('treats an existing image as done', () => {
    const p = applyBuildOutput(
      INITIAL_BUILD_PROGRESS,
      '[build 1:00:00] golden image already exists (use --rebuild to build a new version)\n{"version":"1"}\n',
    )
    expect(p.finished).toBe(true)
    expect(buildPercent(p)).toBe(100)
  })
})
