/** Colors of the Windows caption buttons (the title bar overlay), matched to what is under them. */
export interface OverlayColors {
  color: string
  symbolColor: string
}

/** `rgba(…, 0)` and `transparent` let the parent's background show through. */
export function isTransparent(color: string): boolean {
  const value = color.trim().toLowerCase()
  if (value === '' || value === 'transparent') return true
  const alpha = /^rgba?\([^)]*[,/]\s*([\d.]+%?)\s*\)$/.exec(value)?.[1]
  if (alpha === undefined) return false
  return alpha.endsWith('%') ? Number(alpha.slice(0, -1)) === 0 : Number(alpha) === 0
}

/**
 * The first opaque background from the topmost element down (`backgrounds` in the order of
 * `elementsFromPoint`), else `fallback`. A half-transparent one is still taken: close enough for 3 buttons.
 */
export function visibleBackground(backgrounds: string[], fallback: string): string {
  return backgrounds.find((color) => !isTransparent(color)) ?? fallback
}

/** Where to sample: just left of the window's right edge, inside the caption button row. */
function sampleColors(): OverlayColors {
  const style = getComputedStyle(document.documentElement)
  const fallback = style.getPropertyValue('--bg').trim() || '#fbfbfa'
  const elements = document.elementsFromPoint(Math.max(0, window.innerWidth - 2), 2)
  const color = visibleBackground(
    elements.map((element) => getComputedStyle(element).backgroundColor),
    fallback,
  )
  return { color, symbolColor: style.getPropertyValue('--text-primary').trim() || '#17181b' }
}

/**
 * Windows: keeps the caption buttons painted like the header under them (theme changes, the right
 * panel opening, another screen). Watches the DOM, samples once per frame at most and only sends a
 * change to the main process.
 */
export function startTitleBarSync(send: (colors: OverlayColors) => void): () => void {
  let last = ''
  let frame = 0
  const update = () => {
    frame = 0
    const colors = sampleColors()
    const key = `${colors.color}|${colors.symbolColor}`
    if (key === last) return
    last = key
    send(colors)
  }
  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(update)
  }
  const observer = new MutationObserver(schedule)
  observer.observe(document.documentElement, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['class', 'style', 'data-theme'],
  })
  window.addEventListener('resize', schedule)
  schedule()
  return () => {
    observer.disconnect()
    window.removeEventListener('resize', schedule)
    if (frame) cancelAnimationFrame(frame)
  }
}
