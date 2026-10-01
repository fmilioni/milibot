/** Whether a floating layer (`[data-menu]`) opened after `root` is on screen: Escape closes that one first. */
export function hasLayerAbove(root: Element): boolean {
  return [...document.querySelectorAll('[data-menu]')].some(
    (layer) =>
      !root.contains(layer) && root.compareDocumentPosition(layer) & Node.DOCUMENT_POSITION_FOLLOWING,
  )
}
