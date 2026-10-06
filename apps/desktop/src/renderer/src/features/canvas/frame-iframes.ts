/**
 * The iframe of each frame on the canvas, so the stage can hit-test a frame's page without refs passed
 * through the tree. Only the canvas's own frames register (not the chat's previews).
 */
const iframes = new Map<string, HTMLIFrameElement>()

/** Registers a frame's iframe; the returned cleanup drops it unless another one took its place. */
export function registerFrameIframe(frameId: string, iframe: HTMLIFrameElement): () => void {
  iframes.set(frameId, iframe)
  return () => {
    if (iframes.get(frameId) === iframe) iframes.delete(frameId)
  }
}

/** The loaded page of a frame on the canvas, or null (off screen, still loading, a draft standing in). */
export function frameDocument(frameId: string): Document | null {
  const doc = iframes.get(frameId)?.contentDocument
  return doc?.body ? doc : null
}
