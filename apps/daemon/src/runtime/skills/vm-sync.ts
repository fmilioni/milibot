import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { type GuestExecRequest, type LogFn, SKILLS_VM_ROOT } from '@milibot/shared'

import { buildTar, fitsTar, type TarEntry } from '../../util/tar'
import { type VmController, VmCopyQueue } from '../vm'
import { MIRROR_APPLY_SCRIPT } from './scripts/mirror-apply.generated'
import { MIRROR_LIST_SCRIPT } from './scripts/mirror-list.generated'

/** A skill whose files go to the VM. */
export interface MirroredSkill {
  slug: string
  dir: string
  hash: string
  files: Array<{ path: string; executable: boolean }>
  bytes: number
}

/** Raw bytes of one `/exec` (its stdin travels base64 inside a JSON body of at most 64 MB). */
const MIRROR_BATCH_BYTES = 30 * 1024 * 1024
const MIRROR_ENV = { MILIBOT_SKILLS_ROOT: SKILLS_VM_ROOT, HASH_FILE: '.milibot-hash' }

function mirrorApplyRequest(replace: MirroredSkill[], remove: string[]): GuestExecRequest {
  const entries: TarEntry[] = []
  for (const skill of replace) {
    for (const file of skill.files) {
      const path = `${skill.slug}/${file.path}`
      if (!fitsTar(path)) continue
      entries.push({
        path,
        data: readFileSync(join(skill.dir, file.path)),
        mode: file.executable ? 0o755 : 0o644,
      })
    }
    entries.push({
      path: `${skill.slug}/${MIRROR_ENV.HASH_FILE}`,
      data: Buffer.from(skill.hash),
      mode: 0o644,
    })
  }
  return {
    user: 'root',
    cmd: MIRROR_APPLY_SCRIPT,
    cwd: '/',
    env: { ...MIRROR_ENV, REPLACE: replace.map((s) => s.slug).join(' '), REMOVE: remove.join(' ') },
    stdin: buildTar(entries).toString('base64'),
    timeoutMs: 180_000,
  }
}

export interface SkillVmMirrorDeps {
  vm: Pick<VmController, 'status' | 'subscribe' | 'runningGuest'>
  /** Skills whose files belong in the VM now. */
  desired: () => MirroredSkill[]
  log?: LogFn
}

/**
 * Keeps `/usr/local/share/milibot/skills/<slug>/` in the VM in line with the skills that have files besides
 * SKILL.md: when the VM becomes running and after a skill changes, only skills whose content hash differs are
 * sent, and folders of skills that are gone are deleted.
 */
export class SkillVmMirror {
  private readonly queue: VmCopyQueue
  private timer: NodeJS.Timeout | null = null

  constructor(private readonly deps: SkillVmMirrorDeps) {
    this.queue = new VmCopyQueue({
      name: 'skills VM mirror',
      vm: deps.vm,
      run: () => this.run(),
      ...(deps.log ? { log: deps.log } : {}),
    })
  }

  start(): void {
    this.queue.start()
  }

  async stop(): Promise<void> {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    await this.queue.stop()
  }

  /** A skill changed: sync soon if the VM runs (several changes in a row sync once). */
  schedule(delayMs = 500): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = null
      void this.queue.kick()
    }, delayMs)
  }

  /** Resolves when no sync is running or scheduled (tests). */
  async idle(): Promise<void> {
    while (this.timer) await new Promise((resolve) => setTimeout(resolve, 20))
    await this.queue.idle()
  }

  private async run(): Promise<void> {
    const guest = this.deps.vm.runningGuest()
    const listed = await guest.exec({
      user: 'root',
      cmd: MIRROR_LIST_SCRIPT,
      cwd: '/',
      env: MIRROR_ENV,
      timeoutMs: 30_000,
    })
    if (listed.code !== 0) throw new Error(`listing failed: ${listed.stderr.trim()}`)
    const current = new Map<string, string>()
    for (const line of listed.stdout.split('\n')) {
      const [slug, hash, ...rest] = line.trim().split(' ')
      if (slug && hash && rest.length === 0) current.set(slug, hash)
    }
    const desired: MirroredSkill[] = []
    for (const skill of this.deps.desired()) {
      if (skill.bytes > MIRROR_BATCH_BYTES) {
        this.deps.log?.('warn', 'skill too large for the VM mirror', {
          slug: skill.slug,
          bytes: skill.bytes,
        })
        continue
      }
      desired.push(skill)
    }
    const wanted = new Set(desired.map((s) => s.slug))
    const replace = desired.filter((s) => current.get(s.slug) !== s.hash)
    const remove = [...current.keys()].filter((slug) => !wanted.has(slug))
    if (replace.length === 0 && remove.length === 0) return
    const batches: MirroredSkill[][] = []
    let batch: MirroredSkill[] = []
    let size = 0
    for (const skill of replace) {
      if (batch.length && size + skill.bytes > MIRROR_BATCH_BYTES) {
        batches.push(batch)
        batch = []
        size = 0
      }
      batch.push(skill)
      size += skill.bytes
    }
    if (batch.length || batches.length === 0) batches.push(batch)
    for (const [i, part] of batches.entries()) {
      const result = await guest.exec(mirrorApplyRequest(part, i === 0 ? remove : []))
      if (result.code !== 0) throw new Error(`apply failed: ${result.stderr.trim()}`)
    }
    this.deps.log?.('info', 'skills mirrored in the VM', {
      replaced: replace.map((s) => s.slug),
      removed: remove,
    })
  }
}
