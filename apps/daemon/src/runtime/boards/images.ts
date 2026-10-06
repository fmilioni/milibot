import type { BlobStore } from '@milibot/agent'
import { BOARD_LIMITS, type BoardImage, type LogFn, slugify } from '@milibot/shared'

import { DaemonError, errorMessage } from '../../errors'
import { resolveWorkspacePath } from '../code'
import { imageMediaType, isThumbnailable } from '../files'
import { type VmController, VmCopyQueue } from '../vm'
import { ASSET_IMAGE, assetShas, type BoardRow, type BoardStore, type ImageRow } from './store'

const BOARDS_DIR = '/workspace/boards'
const MAX_IMAGE_BYTES = BOARD_LIMITS.imageBytes
/** `![alt](source)` with an optional title. */
const MARKDOWN_IMAGE = /!\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g

export interface BoardImagesDeps {
  store: BoardStore
  vm: Pick<VmController, 'status' | 'subscribe' | 'runningGuest' | 'guest'>
  blobs: BlobStore & { get(sha: string): Promise<{ mediaType: string; bytes: Uint8Array }> }
  imageFetch?: (url: string, init?: RequestInit) => Promise<Response>
  log?: LogFn
}

/**
 * Card images: blobs referenced as `asset:<sha>` in bodies and comments, each with its path under
 * `/workspace/boards/`, copied into the VM once it runs (`copied = 0` until then).
 */
export class BoardImages {
  private readonly copies: VmCopyQueue

  constructor(private readonly deps: BoardImagesDeps) {
    this.copies = new VmCopyQueue({
      name: 'board image copy',
      vm: deps.vm,
      run: () => this.copyPending(),
      log: deps.log,
    })
  }

  start(): void {
    this.copies.start()
  }

  stop(): Promise<void> {
    return this.copies.stop()
  }

  /** Stores an image of a board (PNG or JPEG) and copies it into the VM when it runs. */
  async add(board: BoardRow, bytes: Uint8Array, name: string): Promise<BoardImage> {
    const type = imageMediaType(bytes)
    if (!isThumbnailable(type))
      throw new DaemonError('validation_failed', 'Only PNG and JPEG images can go on a card', {
        reason: 'image_type',
      })
    const sha = await this.deps.blobs.put(bytes, type)
    const fileName = `${name.replace(/\.[^.]+$/, '')}.${type === 'image/png' ? 'png' : 'jpg'}`
    const row = this.deps.store.putImage(board.id, sha, fileName, imagePath(board, sha, fileName))
    void this.copies.kick()
    return { sha256: sha, name: row.name, path: row.path, markdown: `![${row.name}](asset:${sha})` }
  }

  /** The row an image of another board gets on `board` (a card moving there brings its images). */
  placeIn(board: BoardRow, image: ImageRow): { sha256: string; name: string; path: string } {
    return { sha256: image.sha256, name: image.name, path: imagePath(board, image.sha256, image.name) }
  }

  /** Copies the images not in the VM yet (when it runs). */
  kick(): void {
    void this.copies.kick()
  }

  /** Text as a bot reads it: images as the VM paths it can open. */
  forBot(boardId: string, text: string): string {
    return text.replace(ASSET_IMAGE, (whole, name: string, sha: string) => {
      const image = this.deps.store.image(boardId, sha)
      return image ? `![${name}](${image.path})` : whole
    })
  }

  /** Makes sure the images the texts show are in the VM before a bot reads them (nothing while it is off). */
  async ensure(boardId: string, texts: readonly string[]): Promise<void> {
    const pending = texts.flatMap(assetShas).some((sha) => this.deps.store.image(boardId, sha)?.copied === 0)
    if (pending) await this.copies.kick()
  }

  /** Imports the images a bot's markdown names (VM paths, URLs, data URIs) as `asset:<sha>`. */
  async importMarkdown(board: BoardRow, text: string): Promise<{ text: string; problems: string[] }> {
    const problems: string[] = []
    const replacements = new Map<string, string>()
    for (const match of text.matchAll(MARKDOWN_IMAGE)) {
      const source = match[2] as string
      if (source.startsWith('asset:') || replacements.has(source)) continue
      try {
        const bytes = await this.load(source)
        const name = source.startsWith('data:')
          ? 'image'
          : (source.split(/[/?#]/).filter(Boolean).pop() ?? 'image')
        const image = await this.add(board, bytes, match[1] || name)
        replacements.set(source, `asset:${image.sha256}`)
      } catch (err) {
        problems.push(`The image ${source.slice(0, 80)} was not added: ${errorMessage(err)}.`)
      }
    }
    if (!replacements.size) return { text, problems }
    return {
      text: text.replace(MARKDOWN_IMAGE, (whole, alt: string, source: string) => {
        const asset = replacements.get(source)
        return asset ? `![${alt}](${asset})` : whole
      }),
      problems,
    }
  }

  private async load(source: string): Promise<Uint8Array> {
    let bytes: Uint8Array
    if (source.startsWith('data:')) {
      const m = /^data:[^;,]+(;base64)?,(.*)$/s.exec(source)
      if (!m) throw new Error('malformed data URI')
      bytes = new Uint8Array(
        m[1] ? Buffer.from(m[2] as string, 'base64') : Buffer.from(decodeURIComponent(m[2] as string)),
      )
    } else if (/^https?:\/\//i.test(source)) {
      const res = await (this.deps.imageFetch ?? fetch)(source, { signal: AbortSignal.timeout(20_000) })
      if (!res.ok) throw new Error(`the server answered ${res.status}`)
      bytes = new Uint8Array(await res.arrayBuffer())
    } else {
      const path = resolveWorkspacePath(source)
      if (!path) throw new Error('only files under /workspace can be used')
      const guest = await this.deps.vm.guest()
      bytes = new Uint8Array(
        await guest.fsReadAll(path, {
          maxBytes: MAX_IMAGE_BYTES,
          tooLarge: () => new Error('larger than 10 MB'),
        }),
      )
    }
    if (bytes.length > MAX_IMAGE_BYTES) throw new Error('larger than 10 MB')
    if (!isThumbnailable(imageMediaType(bytes))) throw new Error('only PNG and JPEG images go on cards')
    return bytes
  }

  private async copyPending(): Promise<void> {
    const guest = this.deps.vm.runningGuest()
    for (const image of this.deps.store.uncopiedImages()) {
      try {
        const { bytes } = await this.deps.blobs.get(image.sha256)
        await guest.fsWriteAll(image.path, bytes, { owner: 'agent' })
        this.deps.store.markCopied(image.board_id, image.sha256)
      } catch (err) {
        this.deps.log?.('warn', 'board image copy failed', {
          boardId: image.board_id,
          sha: image.sha256,
          err: errorMessage(err),
        })
      }
    }
  }
}

function imagePath(board: BoardRow, sha: string, name: string): string {
  const folder = `${slugify(board.title).slice(0, 40) || 'board'}-${board.id.slice(-6)}`
  const ext = name.toLowerCase().endsWith('.png') ? 'png' : 'jpg'
  const base = slugify(name.replace(/\.[^.]+$/, '')).slice(0, 40) || 'image'
  return `${BOARDS_DIR}/${folder}/${sha.slice(0, 8)}-${base}.${ext}`
}
