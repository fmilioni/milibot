import type { DesignProblem } from '@milibot/shared'

import { errorMessage } from '../../errors'
import { resolveWorkspacePath } from '../code'
import { imageMediaType, isThumbnailable } from '../files'
import type { VmController } from '../vm'
import type { FontFetch } from './fonts'
import { externalImageSources, replaceSources } from './html'

const MAX_IMAGE_BYTES = 10 * 1024 * 1024

export interface DesignImagesDeps {
  blobs: { put(bytes: Uint8Array, mediaType: string): Promise<string> }
  vm: Pick<VmController, 'guest'>
  /** Downloads images named by http(s) URLs (default: fetch). */
  imageFetch?: FontFetch
}

/** Images named by /workspace paths, URLs or data: URIs become blobs referenced as `asset:<sha>`. */
export class DesignImages {
  constructor(private readonly deps: DesignImagesDeps) {}

  async import(html: string, css: string): Promise<{ html: string; css: string; problems: DesignProblem[] }> {
    const sources = externalImageSources(html, css)
    const replacements = new Map<string, string>()
    const problems: DesignProblem[] = []
    for (const source of sources) {
      try {
        const bytes = await this.load(source)
        const type = imageMediaType(bytes, { svg: true })
        if (!type) throw new Error('it is not an image (png, jpeg, gif, webp or svg)')
        const sha = await this.deps.blobs.put(
          bytes,
          isThumbnailable(type) ? type : 'application/octet-stream',
        )
        replacements.set(source, `asset:${sha}`)
      } catch (err) {
        problems.push({
          kind: 'image_failed',
          message: `The image ${source.slice(0, 80)} could not be added: ${errorMessage(err)}.`,
        })
      }
    }
    if (replacements.size === 0) return { html, css, problems }
    return { html: replaceSources(html, replacements), css: replaceSources(css, replacements), problems }
  }

  private async load(source: string): Promise<Uint8Array> {
    if (source.startsWith('data:')) {
      const m = /^data:[^;,]+(;base64)?,(.*)$/s.exec(source)
      if (!m) throw new Error('malformed data URI')
      return new Uint8Array(
        m[1] ? Buffer.from(m[2] as string, 'base64') : Buffer.from(decodeURIComponent(m[2] as string)),
      )
    }
    if (/^https?:\/\//i.test(source)) {
      const res = await (this.deps.imageFetch ?? fetch)(source, { signal: AbortSignal.timeout(20_000) })
      if (!res.ok) throw new Error(`the server answered ${res.status}`)
      const bytes = new Uint8Array(await res.arrayBuffer())
      if (bytes.length > MAX_IMAGE_BYTES) throw new Error('larger than 10 MB')
      return bytes
    }
    const path = resolveWorkspacePath(source)
    if (!path) throw new Error('only files under /workspace can be used')
    const guest = await this.deps.vm.guest()
    const bytes = await guest.fsReadAll(path, {
      maxBytes: MAX_IMAGE_BYTES,
      tooLarge: () => new Error('larger than 10 MB'),
    })
    return new Uint8Array(bytes)
  }
}
