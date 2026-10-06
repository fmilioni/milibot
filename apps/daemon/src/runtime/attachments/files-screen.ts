import { createHash } from 'node:crypto'
import { existsSync, mkdirSync } from 'node:fs'
import { copyFile, open, rename, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, posix } from 'node:path'

import {
  type FilePage,
  isWorkspaceFilePath,
  ListFilesQuery,
  type MessageAttachment,
  ulid,
} from '@milibot/shared'

import { DaemonError } from '../../errors'
import { hostSafeName, sanitizeFileName } from '../../util/safe-path'
import { GuestError, isVmRunning, type VmController } from '../vm'
import type { AttachmentEvents } from './notify'
import { type AttachmentRow, type AttachmentStore, toMessageAttachment } from './store'
import { fileRemoved, freePath, notAFile, outsideWorkspace, vmNotRunning } from './vm-files'

export interface FilesScreenDeps {
  attachments: AttachmentStore
  events: AttachmentEvents
  vm: Pick<VmController, 'status' | 'runningGuest'>
  /** Where the bytes of an upload not in the VM yet are (`AttachmentUploads.stagingPath`). */
  stagingPath: (id: string) => string
  /** Where "open"/"show in folder" copies files to (default: `$TMPDIR/milibot-attachments`). */
  exportDir?: string
  /** Where copies of `/workspace` files opened from links go (default: `$TMPDIR/milibot-vm-files`). */
  vmFilesDir?: string
  /** Largest file copied to the host (the chats' limit). */
  maxFileBytes: () => number
  copyChunkBytes: number
}

/**
 * The Files screen: the files of the chats live only in the VM (the host keeps no copy once a file is
 * there); rename and delete keep the row and update the message; a file gone from the VM becomes `removed`.
 */
export class FilesScreen {
  constructor(private readonly deps: FilesScreenDeps) {}

  list(input: ListFilesQuery): FilePage {
    const { files, hasMore, totals } = this.deps.attachments.listFiles(ListFilesQuery.parse(input))
    const count = (author: string) => totals.find((t) => t.author === author)?.n ?? 0
    return {
      files,
      hasMore,
      counts: { all: count('bot') + count('user'), bots: count('bot'), user: count('user') },
      totalBytes: totals.reduce((sum, t) => sum + t.bytes, 0),
    }
  }

  /** Renames a sent file inside its VM folder; its message follows the new path. */
  async rename(id: string, name: string): Promise<MessageAttachment> {
    const { attachments } = this.deps
    const row = attachments.row(id)
    if (!row.message_id) throw new DaemonError('conflict', 'The attachment was not sent yet')
    if (row.status === 'removed') throw fileRemoved()
    if (row.status !== 'ready') throw new DaemonError('conflict', 'The file is not in the VM yet')
    const safe = sanitizeFileName(name)
    const target = posix.join(posix.dirname(row.vm_path), safe)
    if (target === row.vm_path) return toMessageAttachment(row)
    if (!isVmRunning(this.deps.vm)) throw vmNotRunning()
    const guest = this.deps.vm.runningGuest()
    const taken = (path: string) => attachments.pathTaken(path, id)
    if (taken(target) || (await freePath(guest, target, taken)) !== target)
      throw new DaemonError('conflict', `A file named ${safe} already exists there`, { code: 'NAME_TAKEN' })
    const moved = await guest.exec({
      user: 'agent',
      cmd: 'mv -n -- "$FROM" "$TO" && test -e "$TO" && test ! -e "$FROM"',
      env: { FROM: row.vm_path, TO: target },
      timeoutMs: 15_000,
    })
    if (moved.code !== 0) {
      await this.missing(row)
      throw new DaemonError('conflict', `Could not rename the file: ${moved.stderr.trim().slice(0, 300)}`)
    }
    attachments.rename(id, safe, target)
    this.deps.events.changed(id)
    return toMessageAttachment(attachments.row(id))
  }

  /** Marks the file removed when the VM no longer has it (then throws `FILE_REMOVED`). */
  private async missing(row: AttachmentRow): Promise<void> {
    try {
      await this.deps.vm.runningGuest().fsReadChunk(row.vm_path, 0, 1)
    } catch (err) {
      if (!(err instanceof GuestError && err.code === 'path_not_found')) return
      this.markRemoved(row.id)
      throw fileRemoved()
    }
  }

  /** Deletes a sent file from the VM (and any bytes still on the host); its message shows it as removed. */
  async delete(id: string): Promise<void> {
    const row = this.deps.attachments.row(id)
    if (!row.message_id) throw new DaemonError('conflict', 'The attachment was not sent yet')
    if (row.status === 'removed') return
    if (row.status === 'copying') throw new DaemonError('conflict', 'The file is being copied into the VM')
    if (row.status === 'ready') {
      if (!isVmRunning(this.deps.vm)) throw vmNotRunning()
      const removed = await this.deps.vm.runningGuest().exec({
        user: 'agent',
        cmd: 'rm -f -- "$ATTACHMENT_PATH"',
        env: { ATTACHMENT_PATH: row.vm_path },
        timeoutMs: 15_000,
      })
      if (removed.code !== 0)
        throw new DaemonError('conflict', `Could not delete the file: ${removed.stderr.trim().slice(0, 300)}`)
    }
    await rm(this.deps.stagingPath(id), { force: true })
    this.markRemoved(id)
  }

  private markRemoved(id: string): void {
    this.deps.attachments.setStatus(id, 'removed')
    this.deps.events.changed(id)
  }

  /** A copy on the host to open with the default app or show in the file manager. */
  async export(id: string): Promise<{ path: string }> {
    const row = this.deps.attachments.row(id)
    const dir = join(this.deps.exportDir ?? join(tmpdir(), 'milibot-attachments'), id)
    const target = join(dir, hostSafeName(posix.basename(row.vm_path)))
    if (existsSync(target) && (await stat(target)).size === row.size) return { path: target }
    mkdirSync(dir, { recursive: true })
    const staged = this.deps.stagingPath(id)
    if (existsSync(staged) && row.status !== 'uploading') {
      await copyFile(staged, target)
      return { path: target }
    }
    if (row.status === 'removed') throw fileRemoved()
    if (row.status !== 'ready') throw new DaemonError('conflict', 'The file is not available yet')
    if (!isVmRunning(this.deps.vm)) throw vmNotRunning()
    const partial = `${target}.part`
    const handle = await open(partial, 'w')
    try {
      await this.deps.vm.runningGuest().fsReadAll(row.vm_path, {
        chunkBytes: this.deps.copyChunkBytes,
        onChunk: async (bytes, offset) => {
          await handle.write(bytes, 0, bytes.length, offset)
        },
      })
    } catch (err) {
      if (!(err instanceof GuestError && err.code === 'path_not_found')) throw err
      await rm(partial, { force: true })
      this.markRemoved(id)
      throw fileRemoved()
    } finally {
      await handle.close()
    }
    await copyFile(partial, target)
    await rm(partial, { force: true })
    return { path: target }
  }

  /**
   * A fresh host copy of a file under `/workspace/` named in text (a link the user clicked), at
   * `<vmFilesDir>/<sha1 of the path>/<name>`. Never boots the VM.
   */
  async exportPath(path: string): Promise<{ path: string }> {
    if (!isWorkspaceFilePath(path))
      throw new DaemonError('validation_failed', 'Not a file path under /workspace', { code: 'NOT_A_FILE' })
    if (!isVmRunning(this.deps.vm)) throw vmNotRunning()
    const guest = this.deps.vm.runningGuest()
    let size: number
    try {
      size = (await guest.fsReadChunk(path, 0, 1)).size
    } catch (err) {
      throw pathError(err)
    }
    if (size > this.deps.maxFileBytes())
      throw new DaemonError('conflict', 'The file is too large to open', { code: 'FILE_TOO_LARGE' })
    const base = this.deps.vmFilesDir ?? join(tmpdir(), 'milibot-vm-files')
    const dir = join(base, createHash('sha1').update(path).digest('hex'))
    const target = join(dir, hostSafeName(posix.basename(path)))
    mkdirSync(dir, { recursive: true })
    // The file may have changed in the VM since the last copy: always copy, then swap it in whole.
    const partial = join(dir, `.${ulid()}.part`)
    const handle = await open(partial, 'w')
    try {
      await guest.fsReadAll(path, {
        chunkBytes: this.deps.copyChunkBytes,
        onChunk: async (bytes, offset) => {
          await handle.write(bytes, 0, bytes.length, offset)
        },
      })
    } catch (err) {
      await handle.close()
      await rm(partial, { force: true })
      throw pathError(err)
    }
    await handle.close()
    await rename(partial, target)
    return { path: target }
  }
}

/** The guest's refusal to read a path named in text, as the error the app shows a message for. */
function pathError(err: unknown): unknown {
  if (!(err instanceof GuestError)) return err
  if (err.code === 'path_not_found') return fileRemoved()
  if (err.code === 'not_a_file') return notAFile()
  if (err.code === 'path_outside_workspace') return outsideWorkspace()
  return err
}
