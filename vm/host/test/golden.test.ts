import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'

import { describe, expect, it } from 'vitest'

import { parseBuildOptions } from '../src/cli/build-golden.ts'
import { checksumFor } from '../src/golden/download.ts'
import { payloadEntries, tarGz } from '../src/golden/payload-tar.ts'
import { lastProvisionLine, parseSerial } from '../src/golden/serial.ts'

const VM_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

describe('golden build', () => {
  it('reads the result markers of the serial console', () => {
    const manifest = Buffer.from(JSON.stringify({ revision: 3, debian: '13.1' })).toString('base64')
    const serial = `boot\r\nMILIBOT_MANIFEST_BEGIN\r\n${manifest.slice(0, 10)}\r\n${manifest.slice(10)}\r\nMILIBOT_MANIFEST_END\r\nMILIBOT_BUILD_RC=0\r\n`
    expect(parseSerial(serial)).toEqual({ rc: 0, manifest: { revision: 3, debian: '13.1' } })
    expect(parseSerial('MILIBOT_BUILD_RC=0\nMILIBOT_BUILD_RC=7\n')).toEqual({ rc: 7, manifest: null })
    expect(parseSerial('nothing')).toEqual({ rc: null, manifest: null })
  })

  it('follows the newest provision line of the serial log', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'milibot-serial-')), 'serial.log')
    expect(lastProvisionLine(file)).toBeNull()
    fs.writeFileSync(file, 'boot\r\n[provision step 3/14 base-packages]\r\n[  12.3] kernel line\r\n')
    expect(lastProvisionLine(file)).toBe('[provision step 3/14 base-packages]')
    fs.rmSync(path.dirname(file), { recursive: true, force: true })
  })

  it('finds a file in a SHA512SUMS listing', () => {
    const sums = 'aaa  debian-13-genericcloud-amd64.qcow2\nbbb  debian-13-genericcloud-arm64.qcow2\n'
    expect(checksumFor(sums, 'debian-13-genericcloud-arm64.qcow2')).toBe('bbb')
    expect(checksumFor(sums, 'other.qcow2')).toBeNull()
  })

  it('parses the build options in both flag spellings and refuses unknown ones', () => {
    expect(parseBuildOptions(['--rebuild', '--cpus=4', '--mem-gb', '6'])).toEqual({
      rebuild: true,
      cpus: 4,
      memGb: 6,
      timeoutMin: 90,
      keepWork: false,
    })
    expect(parseBuildOptions(['-h'])).toBe('help')
    expect(() => parseBuildOptions(['--cpu', '4'])).toThrow(/unknown option/)
    expect(() => parseBuildOptions(['--cpus', '0'])).toThrow(/--cpus/)
  })

  it('ships provision.sh with its steps, the pinned versions and the guest files', () => {
    const bundle = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'milibot-payload-')), 'guest-agent.mjs')
    fs.writeFileSync(bundle, '// agent')
    const entries = payloadEntries(VM_DIR, bundle, { version: '1' })
    const names = entries.map((e) => e.name)
    expect(names.slice(0, 3)).toEqual(['./provision.sh', './versions.env', './provision.d'])
    const steps = fs.readdirSync(path.join(VM_DIR, 'provision.d')).filter((f) => f.endsWith('.sh'))
    for (const step of steps) expect(names).toContain(`./provision.d/${step}`)
    expect(names).toContain('./guest/build-runner.sh')
    expect(names).toContain('./guest/bin/cli-wrapper')
    expect(names.slice(-2)).toEqual(['./guest-agent.mjs', './build-info.json'])
    expect(entries.find((e) => e.name === './provision.sh')?.mode).toBe(0o755)
    fs.rmSync(path.dirname(bundle), { recursive: true, force: true })
  })

  it('writes a ustar archive with modes and long paths', () => {
    const long = `./guest/${'d'.repeat(90)}/${'f'.repeat(40)}.sh`
    const tar = gunzipSync(
      tarGz([
        { name: './guest', dir: true, mode: 0o755 },
        { name: './guest/bin/tool', data: Buffer.from('#!/bin/sh\n'), mode: 0o755 },
        { name: long, data: Buffer.alloc(600, 1), mode: 0o644 },
      ]),
    )
    const header = (offset: number) => ({
      name: tar.toString('utf8', offset, offset + 100).replace(/\0.*$/s, ''),
      mode: parseInt(tar.toString('utf8', offset + 100, offset + 107), 8),
      size: parseInt(tar.toString('utf8', offset + 124, offset + 135), 8),
      type: tar.toString('utf8', offset + 156, offset + 157),
      magic: tar.toString('utf8', offset + 257, offset + 262),
      prefix: tar.toString('utf8', offset + 345, offset + 500).replace(/\0.*$/s, ''),
    })
    expect(header(0)).toMatchObject({ name: './guest/', type: '5', mode: 0o755, magic: 'ustar' })
    expect(header(512)).toMatchObject({ name: './guest/bin/tool', size: 10, mode: 0o755, type: '0' })
    const third = header(1536)
    expect(`${third.prefix}/${third.name}`).toBe(long)
    expect(third.size).toBe(600)
    let sum = 0
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : (tar[i] as number)
    expect(parseInt(tar.toString('utf8', 148, 154), 8)).toBe(sum)
    expect(tar.length % 512).toBe(0)
  })
})
