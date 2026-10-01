import { execFile } from 'node:child_process'
import fs from 'node:fs'
import { promisify } from 'node:util'

import { CliError } from '../lib/args.ts'
import { actualBytes } from '../lib/host.ts'
import type { VmCliDisk, VmConfigFile } from '../lib/shared.ts'
import type { VmHostContext } from './context.ts'
import { qmp, qmpEndpoint } from './qmp.ts'

const execFileAsync = promisify(execFile)

/** The part of `qemu-img info --output=json` (and QMP's `query-block` image) that is read. */
export interface ImageInfo {
  'virtual-size': number
  'backing-filename'?: string
  'full-backing-filename'?: string
  snapshots?: Array<{ id: string; name: string; 'date-sec': number }>
}

export async function qemuImg(ctx: VmHostContext, ...args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync(ctx.profile().qemuImgBinary, args, {
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
    })
    return stdout
  } catch (err) {
    const e = err as { stderr?: string; message?: string }
    const msg = (e.stderr || e.message || '').trim()
    if (/lock/i.test(msg)) throw new CliError('VM_RUNNING', `disk is locked by a running VM: ${msg}`)
    throw new CliError('QEMU_IMG_FAILED', msg)
  }
}

export async function imageInfo(ctx: VmHostContext, file: string): Promise<ImageInfo> {
  return JSON.parse(await qemuImg(ctx, 'info', '--force-share', '--output=json', file)) as ImageInfo
}

/**
 * Windows opens a running VM's disks without write sharing, so `qemu-img info` fails there even with
 * `--force-share`: then QEMU itself describes the drive (`query-block` returns the same image info).
 */
async function liveImageInfo(
  ctx: VmHostContext,
  config: VmConfigFile,
  drive: string,
): Promise<ImageInfo | null> {
  const [res] = await qmp(qmpEndpoint(ctx.profile(), config), [{ execute: 'query-block' }])
  const blocks = (res?.return ?? []) as Array<{ device?: string; inserted?: { image?: ImageInfo } }>
  return blocks.find((b) => b.device === drive)?.inserted?.image ?? null
}

/** `live`: the running VM's config and drive id, used when qemu-img can't open the disk. */
export async function diskInfo(
  ctx: VmHostContext,
  file: string,
  live: { config: VmConfigFile; drive: string } | null = null,
): Promise<VmCliDisk> {
  if (!fs.existsSync(file)) return { path: file, exists: false }
  let info: ImageInfo | null
  try {
    info = await imageInfo(ctx, file)
  } catch (err) {
    info = live ? await liveImageInfo(ctx, live.config, live.drive).catch(() => null) : null
    if (!info) throw err
  }
  const backing = info['full-backing-filename'] ?? info['backing-filename']
  return {
    path: file,
    exists: true,
    virtualBytes: info['virtual-size'],
    actualBytes: actualBytes(file),
    ...(backing ? { backingFile: backing } : {}),
    snapshots: (info.snapshots ?? []).map((s) => ({
      id: s.id,
      name: s.name,
      date: new Date(s['date-sec'] * 1000).toISOString(),
    })),
  }
}

export async function snapshotsOf(
  ctx: VmHostContext,
  file: string,
  live: { config: VmConfigFile; drive: string } | null = null,
) {
  const disk = await diskInfo(ctx, file, live)
  return disk.exists ? disk.snapshots : []
}
