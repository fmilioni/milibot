import { meterLine } from '@milibot/vm-host'
import { describe, expect, it } from 'vitest'

import { applyBuildOutput, INITIAL_BUILD_PROGRESS, parseCurlMeter } from '../../src/golden/progress'

describe('golden build output', () => {
  it('prints a download meter golden-progress understands', () => {
    const line = meterLine(150 * 1024 ** 2, 350 * 1024 ** 2, 15)
    expect(parseCurlMeter(line)).toEqual({ percent: 42, totalBytes: 350 * 1024 ** 2, leftSeconds: 20 })
    const progress = applyBuildOutput(
      INITIAL_BUILD_PROGRESS,
      `[build 10:00:00] checking base image\n[build 10:00:01] downloading debian-13-genericcloud-amd64.qcow2\n${line}\r`,
    )
    expect(progress).toMatchObject({
      stage: 'download',
      downloadBytes: 350 * 1024 ** 2,
      downloadLeftSeconds: 20,
    })
    expect(progress.stageFraction).toBeCloseTo(0.42)
    // Unknown size: still a valid meter line, without an estimate.
    expect(parseCurlMeter(meterLine(1000, null, 1))).toMatchObject({ percent: 0, leftSeconds: null })
  })
})
