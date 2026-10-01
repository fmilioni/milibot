import { mkdirSync } from 'node:fs'
import { copyFile, readFile, rename, rm } from 'node:fs/promises'
import { join, posix } from 'node:path'

import {
  type Bot,
  type BotScope,
  type CreateKnowledgeUploadBody,
  type KnowledgeDoc,
  type KnowledgeFromAttachmentBody,
  type KnowledgeSource,
  newId,
  type UploadChunkBody,
  type UploadProgress,
} from '@milibot/shared'

import { DaemonError, notFound } from '../../errors'
import type { Parsed } from '../../handlers'
import { sha256 } from '../../util/hash'
import { hostSafeName } from '../../util/safe-path'
import { assertUploadComplete, isLegacyOfficeKind, sniffFile, writeChunkAt } from '../files'
import { SUMMARY_CORPUS } from './corpus'
import { docDir, kindFromName, mimeOf, noteFileName, originalPath, uploadsDir } from './files'
import { DocFailure, kindFor, type KnowledgeCore, type KnowledgePipeline, MB, readVmFile } from './pipeline'
import type { KnowledgeService } from './service'
import type { DocRow } from './store'

interface UploadSession {
  id: string
  name: string
  size: number
  mimeType: string
  title: string | null
  scope: BotScope
  projectId: string | null
  received: number
  file: string
}

export function vmPathOf(path: string): string | null {
  const trimmed = path.trim()
  if (!trimmed) return null
  const absolute = trimmed.startsWith('/') ? posix.normalize(trimmed) : posix.join('/workspace', trimmed)
  return absolute === '/workspace' || !absolute.startsWith('/workspace/') ? null : absolute
}

function titleFromName(name: string): string {
  const base = name
    .replace(/\.[a-z0-9]{1,8}$/i, '')
    .replace(/[_]+/g, ' ')
    .trim()
  return (base || name).slice(0, 200)
}

/** How documents come in: uploads, chat attachments, VM files (`knowledge_add`) and the bots' notes. */
export class KnowledgeIntake {
  private readonly uploads = new Map<string, UploadSession>()

  constructor(
    private readonly core: KnowledgeCore,
    private readonly pipeline: KnowledgePipeline,
    private readonly service: Pick<KnowledgeService, 'checkProject' | 'reindex'>,
  ) {}

  private get deps() {
    return this.core.deps
  }

  private tooLarge(size: number): DaemonError | null {
    const maxFileMb = this.deps.attachments.maxFileMb()
    return size > maxFileMb * MB
      ? new DaemonError('validation_failed', `The file is larger than ${maxFileMb} MB`, {
          reason: 'too_large',
          maxFileMb,
        })
      : null
  }

  createUpload(body: Parsed<typeof CreateKnowledgeUploadBody>): UploadProgress {
    const tooLarge = this.tooLarge(body.size)
    if (tooLarge) throw tooLarge
    const id = newId('knowledgeUpload')
    const dir = uploadsDir(this.deps.workspaceDir)
    mkdirSync(dir, { recursive: true })
    const session: UploadSession = {
      id,
      name: posix.basename(body.name.replace(/\\/g, '/')),
      size: body.size,
      mimeType: body.mimeType,
      title: body.title ?? null,
      scope: body.scope ?? 'all',
      projectId: this.service.checkProject(body.projectId ?? null),
      received: 0,
      file: join(dir, id),
    }
    this.uploads.set(id, session)
    return { id, name: session.name, size: session.size, received: 0 }
  }

  private upload(id: string): UploadSession {
    const session = this.uploads.get(id)
    if (!session) throw notFound('knowledge upload', id)
    return session
  }

  async writeUploadChunk(id: string, chunk: UploadChunkBody): Promise<{ received: number }> {
    const session = this.upload(id)
    session.received = await writeChunkAt(session.file, session.received, session.size, chunk)
    return { received: session.received }
  }

  async completeUpload(id: string): Promise<KnowledgeDoc> {
    const session = this.upload(id)
    await assertUploadComplete(session.file, session.received, session.size)
    this.uploads.delete(id)
    try {
      return await this.addFile({
        file: session.file,
        fileName: session.name,
        mime: session.mimeType,
        title: session.title,
        scope: session.scope,
        projectId: session.projectId,
        source: 'upload',
        sourceRef: null,
        authorBotId: null,
        conversationId: null,
        move: true,
      })
    } finally {
      await rm(session.file, { force: true })
    }
  }

  async cancelUpload(id: string): Promise<void> {
    const session = this.uploads.get(id)
    this.uploads.delete(id)
    if (session) await rm(session.file, { force: true })
  }

  /** A document from a file on the host (upload, staged attachment, file read from the VM). */
  private async addFile(input: {
    file: string
    fileName: string
    mime: string
    title: string | null
    scope: BotScope
    projectId: string | null
    source: KnowledgeSource
    sourceRef: string | null
    authorBotId: string | null
    conversationId: string | null
    /** Move instead of copy (the upload's staging file). */
    move: boolean
    /** Existing document to update (same VM path). */
    replace?: DocRow | null
  }): Promise<KnowledgeDoc> {
    const bytes = await readFile(input.file)
    const kind = kindFor(input.fileName, bytes)
    this.assertLegacyOfficeAllowed(input.fileName, bytes)
    const title = input.title?.trim() || titleFromName(input.fileName)
    const fields = {
      fileName: input.fileName,
      mime: mimeOf(kind, input.mime),
      kind,
      bytes: bytes.length,
      sha256: sha256(bytes),
    }
    let row: DocRow
    if (input.replace) {
      this.pipeline.abort(input.replace.id)
      await rm(docDir(this.deps.workspaceDir, input.replace.id), { recursive: true, force: true })
      this.core.forgetContent(input.replace.id)
      row = this.core.docs.update(input.replace.id, {
        ...fields,
        title: input.title?.trim() || input.replace.title,
        projectId: input.projectId,
        status: 'queued',
        progress: 0,
        errorCode: null,
        error: null,
        summary: null,
      })
    } else {
      row = this.core.docs.insertDoc({
        ...fields,
        title,
        source: input.source,
        sourceRef: input.sourceRef,
        authorType: input.authorBotId ? 'bot' : 'user',
        authorBotId: input.authorBotId,
        conversationId: input.conversationId,
        scope: input.scope,
        projectId: input.projectId,
      })
    }
    const target = originalPath(this.deps.workspaceDir, row.id, input.fileName)
    mkdirSync(docDir(this.deps.workspaceDir, row.id), { recursive: true })
    if (input.move) await rename(input.file, target).catch(() => copyFile(input.file, target))
    else await copyFile(input.file, target)
    const doc = this.core.changed(row.id) as KnowledgeDoc
    this.pipeline.pump()
    return doc
  }

  private assertLegacyOfficeAllowed(name: string, bytes: Uint8Array): void {
    const sniffed = sniffFile(name, bytes.subarray(0, 64 * 1024))
    if (sniffed.type !== 'document' || !isLegacyOfficeKind(sniffed.kind) || this.core.legacyOffice().enabled)
      return
    throw new DaemonError(
      'validation_failed',
      `${name} is an old Office file (.${sniffed.kind}): reading it needs "Old Office files" turned on in Settings › Knowledge (it installs LibreOffice in the VM)`,
      { reason: 'unsupported_format', hint: 'legacy_office_disabled' },
    )
  }

  /** "Add to knowledge" on a chat attachment: a copy of its bytes (host staging or the VM). */
  async fromAttachment(body: KnowledgeFromAttachmentBody): Promise<KnowledgeDoc> {
    const attachment = this.deps.attachments.get(body.attachmentId)
    if (attachment.status === 'uploading' || attachment.status === 'failed')
      throw new DaemonError('conflict', 'The attachment is not available', { reason: attachment.status })
    const existing = this.core.docs.bySource('attachment', attachment.id)
    if (existing) return this.core.toDoc(existing)
    const tooLarge = this.tooLarge(attachment.size)
    if (tooLarge) throw tooLarge
    const projectId =
      body.projectId !== undefined
        ? this.service.checkProject(body.projectId)
        : this.conversationProject(attachment.conversationId)
    const common = {
      fileName: attachment.name,
      mime: attachment.mimeType,
      title: body.title ?? null,
      scope: body.scope ?? ('all' as const),
      projectId,
      source: 'attachment' as const,
      sourceRef: attachment.id,
      authorBotId: null,
      conversationId: attachment.conversationId,
    }
    const staged = this.deps.attachments.stagedFile(attachment.id)
    if (staged) return this.addFile({ ...common, file: staged, move: false })
    // In the VM only: copied from there now, or when the VM is running again.
    const row = this.core.docs.insertDoc({
      title: body.title?.trim() || titleFromName(attachment.name),
      fileName: attachment.name,
      mime: attachment.mimeType,
      kind: kindFromName(attachment.name),
      source: 'attachment',
      sourceRef: attachment.id,
      authorType: 'user',
      conversationId: attachment.conversationId,
      bytes: attachment.size,
      scope: body.scope ?? 'all',
      projectId,
    })
    const doc = this.core.changed(row.id) as KnowledgeDoc
    this.pipeline.pump()
    return doc
  }

  /** `knowledge_add`: copies a VM file into the knowledge base (the same path again updates that document). */
  async addFromVm(
    bot: Bot,
    input: {
      path: string
      title?: string | null
      scope: BotScope
      /** undefined keeps an updated document's project. */
      projectId?: string | null
      /** Project of a new document when `projectId` is not given. */
      newDocProjectId?: string | null
      conversationId: string | null
    },
  ): Promise<{ doc: KnowledgeDoc; updated: boolean }> {
    const path = vmPathOf(input.path)
    if (!path) throw new DaemonError('validation_failed', 'The path must be a file under /workspace')
    const existing = this.core.docs.bySource('vm_file', path)
    if (this.deps.vm.status().state !== 'running') {
      if (existing) {
        if (input.projectId !== undefined)
          this.core.docs.update(existing.id, { projectId: input.projectId }, false)
        return { doc: this.service.reindex(existing.id), updated: true }
      }
      const name = hostSafeName(posix.basename(path))
      const row = this.core.docs.insertDoc({
        title: input.title?.trim() || titleFromName(name),
        fileName: name,
        mime: '',
        kind: kindFromName(name),
        source: 'vm_file',
        sourceRef: path,
        authorType: 'bot',
        authorBotId: bot.id,
        conversationId: input.conversationId,
        bytes: 0,
        scope: input.scope,
        projectId: input.projectId ?? input.newDocProjectId ?? null,
      })
      const doc = this.core.changed(row.id) as KnowledgeDoc
      return { doc, updated: false }
    }
    const temp = join(uploadsDir(this.deps.workspaceDir), newId('knowledgeUpload'))
    mkdirSync(uploadsDir(this.deps.workspaceDir), { recursive: true })
    try {
      await readVmFile(this.deps.vm.runningGuest(), path, temp, this.deps.attachments.maxFileMb())
      const doc = await this.addFile({
        file: temp,
        fileName: hostSafeName(posix.basename(path)),
        mime: '',
        title: input.title ?? null,
        scope: input.scope,
        projectId:
          input.projectId !== undefined
            ? input.projectId
            : existing
              ? existing.project_id
              : (input.newDocProjectId ?? null),
        source: 'vm_file',
        sourceRef: path,
        authorBotId: bot.id,
        conversationId: input.conversationId,
        move: true,
        replace: existing,
      })
      return { doc, updated: existing !== null }
    } finally {
      await rm(temp, { force: true })
    }
  }

  /** `knowledge_write`: a markdown document written by a bot (new, or replacing a team document). */
  writeNote(
    bot: Bot,
    input: {
      title: string
      content: string
      replace: DocRow | null
      pinned?: boolean
      /** undefined keeps a replaced document's project. */
      projectId?: string | null
      conversationId: string | null
    },
  ): { doc: KnowledgeDoc; created: boolean } {
    const content = input.content.replace(/\r\n?/g, '\n')
    const bytes = Buffer.byteLength(content)
    if (input.replace) {
      const id = input.replace.id
      this.core.writeContent(id, content)
      const own = input.replace.author_bot_id === bot.id
      this.core.docs.update(id, {
        title: input.title,
        fileName: noteFileName(input.title),
        bytes,
        sha256: sha256(content),
        ...(own && input.pinned !== undefined ? { pinned: input.pinned } : {}),
        ...(input.projectId !== undefined ? { projectId: input.projectId } : {}),
      })
      this.pipeline.rechunk(id, { summarizeIfChanged: true })
      if (input.title !== input.replace.title) void this.core.embeddings.refreshCorpus(SUMMARY_CORPUS, [id])
      return { doc: this.core.changed(id) as KnowledgeDoc, created: false }
    }
    const row = this.core.docs.insertDoc({
      title: input.title,
      fileName: noteFileName(input.title),
      mime: 'text/markdown',
      kind: 'note',
      source: 'bot',
      authorType: 'bot',
      authorBotId: bot.id,
      conversationId: input.conversationId,
      bytes,
      sha256: sha256(content),
      pinned: input.pinned === true,
      projectId: input.projectId ?? null,
    })
    this.core.writeContent(row.id, content)
    const doc = this.core.changed(row.id) as KnowledgeDoc
    this.pipeline.pump()
    return { doc, created: true }
  }

  /** `knowledge_edit`: exact replacement in a team document; only the changed chunks are embedded again. */
  editNote(row: DocRow, oldText: string, newText: string, replaceAll: boolean): { replaced: number } {
    const content = this.core.readContent(row.id)
    if (content === null) throw new DocFailure('file_missing', 'The document has no content')
    const count = oldText ? content.split(oldText).length - 1 : 0
    if (count === 0) throw new DocFailure('no_match', 'old_text was not found in the document')
    if (count > 1 && !replaceAll)
      throw new DocFailure(
        'ambiguous',
        `old_text matches ${count} places; give more context or set replace_all`,
      )
    const next = replaceAll ? content.split(oldText).join(newText) : content.replace(oldText, () => newText)
    this.core.writeContent(row.id, next)
    this.core.docs.update(row.id, { bytes: Buffer.byteLength(next), sha256: sha256(next) })
    this.pipeline.rechunk(row.id, { summarizeIfChanged: true })
    this.core.changed(row.id)
    return { replaced: replaceAll ? count : 1 }
  }

  private conversationProject(conversationId: string | null): string | null {
    if (!conversationId) return null
    return this.core.deps.projects.ofConversation(conversationId)
  }
}
