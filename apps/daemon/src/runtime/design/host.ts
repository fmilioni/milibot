import type { ArtworkGenerator } from './artwork'
import type { DesignCompiler } from './compile'
import type { ArtRef } from './html'
import type { DesignRenderBackend } from './render'
import type { DesignRow, DesignStore, FrameRow, RevisionAuthor, RevisionSnapshot } from './store'

/** What the design helpers (frames, layout checks, output) use of the service that owns them. */
export interface DesignHost {
  readonly store: DesignStore
  readonly compiler: DesignCompiler
  readonly artwork: ArtworkGenerator | null
  readonly render: DesignRenderBackend
  now(): number
  compileRow(design: DesignRow, frame: FrameRow, theme?: string | null): ReturnType<DesignCompiler['compile']>
  artFor(designId: string, html: string): Record<string, ArtRef | null> | undefined
  frameUrl(designId: string, frameId: string, theme: string | null): Promise<string>
  printUrl(designId: string, frameIds: readonly string[]): Promise<string>
  saveFrame(
    design: DesignRow,
    before: FrameRow | null,
    after: FrameRow,
    author: RevisionAuthor,
    summary: string | null,
  ): FrameRow
  emitFrame(designId: string, frame: FrameRow, deleted?: boolean): void
  emitDesign(row: DesignRow): unknown
  revision(
    designId: string,
    frameId: string | null,
    author: RevisionAuthor,
    summary: string,
    snapshot: RevisionSnapshot,
  ): void
  scheduleThumbnail(designId: string): void
}
