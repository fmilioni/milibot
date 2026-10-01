import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { type GoldenStatus, resolveGoldenFile } from '@milibot/shared'
import { goldenFs } from '@milibot/vm-host'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { GoldenBuilder } from '../../src/golden/builder'
import { removeDir, tempDir } from '../support/temp'
import { until as untilDefault } from '../support/wait'

/** Writes a versioned golden with the revision from `golden-revision` next to it, like vm/build.sh. */
const FAKE_BUILD = `#!/bin/bash
echo "run $*" >> "$MILIBOT_HOME/build-args"
echo "[build 10:00:00] flattening into golden" >&2
dir="$(cd "$(dirname "$0")" && pwd)"
rev="$(cat "$dir/golden-revision")"
images="$MILIBOT_HOME/images"
mkdir -p "$images"
: > "$images/debian13-golden-$rev-arm64.qcow2"
echo "{\\"revision\\": $rev}" > "$images/debian13-golden-$rev-arm64.json"
echo "{\\"version\\": 1, \\"images\\": {\\"arm64\\": \\"debian13-golden-$rev-arm64.qcow2\\"}}" > "$images/current.json"
echo "[build 10:00:01] golden image ready in 1s" >&2
`

let root: string
let dataRoot: string
let vmDir: string
let builder: GoldenBuilder | null = null
const statuses: GoldenStatus[] = []
let readyCount = 0

beforeEach(() => {
  root = tempDir('golden')
  dataRoot = join(root, 'data')
  vmDir = join(root, 'vm')
  mkdirSync(join(dataRoot, 'images'), { recursive: true })
  mkdirSync(vmDir)
  writeFileSync(join(vmDir, 'build.sh'), FAKE_BUILD)
  chmodSync(join(vmDir, 'build.sh'), 0o755)
  statuses.length = 0
  readyCount = 0
})

afterEach(() => {
  builder?.close()
  builder = null
  removeDir(root)
})

function create(latest: number): GoldenBuilder {
  writeFileSync(join(vmDir, 'golden-revision'), `${latest}\n`)
  const images = join(dataRoot, 'images')
  builder = new GoldenBuilder({
    dataRoot,
    golden: () => resolveGoldenFile(images, 'arm64', goldenFs, process.platform),
    script: join(vmDir, 'build.sh'),
    env: { PATH: process.env.PATH, MILIBOT_BUILD_DIR: join(root, 'build') },
    onStatus: (status) => statuses.push(status),
    onReady: () => {
      readyCount++
    },
    log: () => undefined,
  })
  return builder
}

/** A golden of revision 1. */
function firstGolden(): void {
  const images = join(dataRoot, 'images')
  writeFileSync(join(images, 'debian13-golden-100-arm64.qcow2'), '')
  writeFileSync(join(images, 'debian13-golden-100-arm64.json'), '{"revision": 1}')
  writeFileSync(
    join(images, 'current.json'),
    JSON.stringify({ version: 1, images: { arm64: 'debian13-golden-100-arm64.qcow2' } }),
  )
}

const until = (check: () => boolean) => untilDefault(check, 10_000, 20)

describe('GoldenBuilder revisions', () => {
  it('reports an image older than the app revision as outdated and rebuilds it', async () => {
    firstGolden()
    const golden = create(2)
    expect(golden.status()).toMatchObject({ state: 'ready', revision: 1, latestRevision: 2, outdated: true })

    expect(golden.build().state).toBe('building')
    await until(() => golden.status().state === 'ready' && !golden.status().outdated)
    expect(readFileSync(join(dataRoot, 'build-args'), 'utf8').trim()).toBe('run --rebuild')
    expect(golden.status()).toMatchObject({ revision: 2, latestRevision: 2, outdated: false, error: null })
    expect(readyCount).toBe(1)
    expect(statuses.at(-1)).toMatchObject({ state: 'ready', outdated: false })
  })

  it('does nothing when the image is current and builds a missing one without --rebuild', async () => {
    const golden = create(1)
    expect(golden.status()).toMatchObject({ state: 'missing', revision: null, outdated: false })
    golden.build()
    await until(() => golden.status().state === 'ready')
    expect(readFileSync(join(dataRoot, 'build-args'), 'utf8').trim()).toBe('run')

    expect(golden.build()).toMatchObject({ state: 'ready', revision: 1, outdated: false })
    expect(readFileSync(join(dataRoot, 'build-args'), 'utf8').trim().split('\n')).toHaveLength(1)
  })

  it('fails when the build finishes without the new revision', async () => {
    firstGolden()
    const golden = create(3)
    writeFileSync(join(vmDir, 'build.sh'), '#!/bin/bash\nexit 0\n')
    golden.build()
    await until(() => golden.status().state !== 'building')
    expect(golden.status()).toMatchObject({ state: 'ready', outdated: true })
    expect(golden.status().error).toBeTruthy()
  })
})
