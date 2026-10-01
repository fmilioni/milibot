/** A frame of a print document (PDF export): one page per frame. */
export interface PrintFrame {
  width: number
  /** Null: grows with its content (measured by `PRINT_PREPARE_SCRIPT`). */
  height: number | null
  /** Last known height of an `auto` frame, used until the page measures it. */
  measuredHeight?: number | null
}

export function escapeAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;')
}

/**
 * One document with a page per frame: each frame's own page in an `<iframe>` (their styles must not mix),
 * sized by `PRINT_PREPARE_SCRIPT` (named @page per frame) before printing. `frameSource` gives the iframe's
 * `src="…"` or `srcdoc="…"` attribute; `extraHead` goes right after the charset.
 */
export function printDocument<F extends PrintFrame>(
  frames: readonly F[],
  frameSource: (frame: F) => string,
  extraHead?: string,
): string {
  const sections = frames.map((f, i) => {
    const height = f.height ?? 0
    const shown = height || f.measuredHeight || 1000
    return (
      `<section class="p${i}" style="width:${f.width}px;height:${shown}px">` +
      `<iframe ${frameSource(f)} data-width="${f.width}" data-height="${height}" ` +
      `width="${f.width}" height="${shown}"></iframe></section>`
    )
  })
  const named = frames.map((_, i) => `section.p${i} { page: p${i} }`).join('\n')
  return [
    '<!doctype html>',
    '<html><head><meta charset="utf-8">',
    ...(extraHead ? [extraHead] : []),
    '<style>html,body{margin:0;padding:0}section{display:block;overflow:hidden;break-after:page;break-inside:avoid}' +
      `section:last-child{break-after:auto}iframe{border:0;display:block}\n${named}</style>`,
    `</head><body>${sections.join('')}</body></html>`,
  ].join('\n')
}

/** Waits for each frame's fonts and images, sizes `auto` frames and adds a named @page per frame. */
export const PRINT_PREPARE_SCRIPT = String.raw`
(async () => {
  const frames = [...document.querySelectorAll('iframe')]
  await Promise.all(frames.map((f) => f.contentDocument && f.contentDocument.readyState === 'complete' ? null : new Promise((r) => { f.addEventListener('load', r, { once: true }); setTimeout(r, 15000) })))
  const rules = []
  for (const [i, f] of frames.entries()) {
    const doc = f.contentDocument
    if (doc) {
      await doc.fonts.ready
      await Promise.all([...doc.images].map((img) => img.complete ? null : new Promise((r) => { img.onload = img.onerror = r })))
    }
    const width = Number(f.dataset.width)
    let height = Number(f.dataset.height)
    if (!height && doc) height = Math.ceil(doc.body.scrollHeight)
    height = height || 1000
    f.style.height = height + 'px'
    f.parentElement.style.height = height + 'px'
    rules.push('@page p' + i + ' { size: ' + width + 'px ' + height + 'px; margin: 0 }')
    if (i === 0) rules.push('@page { size: ' + width + 'px ' + height + 'px; margin: 0 }')
  }
  const style = document.createElement('style')
  style.textContent = rules.join('\n')
  document.head.appendChild(style)
  return frames.length
})()
`
