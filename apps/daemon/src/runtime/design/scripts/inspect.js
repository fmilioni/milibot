// Runs inside a rendered frame (CDP `Runtime.evaluate`, which the page's CSP does not block): waits for fonts
// and images, then measures the content height and reports layout problems and a compact outline. The daemon
// calls it with (frameWidth, frameHeight); it resolves to {height, contentHeight, problems, outline}.
/* exported inspect */
async function inspect(frameWidth, frameHeight) {
  const MAX_PROBLEMS = 15
  const MAX_OUTLINE = 120
  await document.fonts.ready
  await Promise.all(
    [...document.images].map((img) =>
      img.complete
        ? null
        : new Promise((r) => {
            img.onload = img.onerror = r
          }),
    ),
  )
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
  const body = document.body
  const contentHeight = Math.ceil(Math.max(body.scrollHeight, body.getBoundingClientRect().height))
  const height = frameHeight || contentHeight
  const problems = []
  const add = (kind, message) => {
    if (problems.length < MAX_PROBLEMS) problems.push({ kind, message: message.slice(0, 240) })
  }
  const clip = (s, n) => {
    const t = s.replace(/\s+/g, ' ').trim()
    return t.length > n ? t.slice(0, n - 1) + '…' : t
  }
  const ownText = (el) =>
    [...el.childNodes]
      .filter((n) => n.nodeType === 3)
      .map((n) => n.textContent)
      .join(' ')
      .trim()
  const label = (el) => {
    const tag = el.tagName.toLowerCase()
    const id = el.getAttribute('data-id') || el.id
    const icon = el.getAttribute('data-icon')
    const text = clip(el.innerText || el.textContent || '', 40)
    return tag + (id ? '#' + id : '') + (icon ? ' ' + icon : '') + (text ? ' "' + text + '"' : '')
  }
  const box = (r) =>
    '(' +
    Math.round(r.left) +
    ',' +
    Math.round(r.top) +
    ' ' +
    Math.round(r.width) +
    '×' +
    Math.round(r.height) +
    ')'
  const visible = (el, cs) => cs.display !== 'none' && cs.visibility !== 'hidden' && Number(cs.opacity) > 0
  const clips = (cs) => /(hidden|clip|auto|scroll)/.test(cs.overflowX + ' ' + cs.overflowY)
  const inSvg = (el) => el.namespaceURI === 'http://www.w3.org/2000/svg' && el.tagName.toLowerCase() !== 'svg'

  const all = [...body.querySelectorAll('*')].filter((el) => !inSvg(el))
  const styles = new Map(all.map((el) => [el, getComputedStyle(el)]))
  const reportedOutside = new Set()
  for (const el of all) {
    const cs = styles.get(el)
    if (!visible(el, cs)) continue
    const r = el.getBoundingClientRect()
    if (r.width === 0 && r.height === 0) continue
    const inline = cs.display === 'inline' || cs.display === 'contents'
    const intentional =
      cs.textOverflow === 'ellipsis' || (cs.webkitLineClamp && cs.webkitLineClamp !== 'none')
    if (!inline && !intentional && clips(cs) && !/(auto|scroll)/.test(cs.overflowX + cs.overflowY)) {
      const dx = el.scrollWidth - el.clientWidth
      const dy = el.scrollHeight - el.clientHeight
      if (dx > 1 || dy > 1)
        add(
          'text_overflow',
          label(el) +
            ' ' +
            box(r) +
            ' cuts off its content (' +
            (dx > 1 ? dx + 'px wider' : '') +
            (dx > 1 && dy > 1 ? ', ' : '') +
            (dy > 1 ? dy + 'px taller' : '') +
            ' than the box).',
        )
    } else if (!inline && !intentional && ownText(el) && el.scrollWidth > el.clientWidth + 1) {
      add(
        'text_overflow',
        label(el) +
          ' ' +
          box(r) +
          ': its text is ' +
          (el.scrollWidth - el.clientWidth) +
          'px wider than the box and spills out.',
      )
    }
    const outside = r.left < -1 || r.top < -1 || r.right > frameWidth + 1 || r.bottom > height + 1
    if (outside) {
      let parent = el.parentElement
      let covered = false
      while (parent && parent !== body) {
        if (reportedOutside.has(parent) || clips(styles.get(parent))) {
          covered = true
          break
        }
        parent = parent.parentElement
      }
      if (!covered) {
        reportedOutside.add(el)
        add(
          'outside_frame',
          label(el) +
            ' ' +
            box(r) +
            ' goes past the frame (' +
            frameWidth +
            '×' +
            height +
            ') and is cut off.',
        )
      }
    }
    if (el.tagName === 'IMG' && el.complete && el.naturalWidth === 0)
      add('image_failed', 'The image ' + clip(el.getAttribute('src') || '', 60) + ' did not load.')
  }

  for (const parent of [body, ...all]) {
    const pcs = parent === body ? getComputedStyle(body) : styles.get(parent)
    if (!pcs || pcs.display === 'grid' || pcs.display === 'inline-grid') continue
    const kids = [...parent.children]
      .filter((k) => {
        const cs = styles.get(k)
        return (
          cs &&
          visible(k, cs) &&
          !inSvg(k) &&
          cs.display !== 'inline' &&
          cs.display !== 'contents' &&
          (cs.position === 'static' || cs.position === 'relative') &&
          cs.float === 'none'
        )
      })
      .slice(0, 60)
    const rects = kids.map((k) => k.getBoundingClientRect())
    for (let i = 0; i < kids.length; i++)
      for (let j = i + 1; j < kids.length; j++) {
        const a = rects[i],
          b = rects[j]
        const w = Math.min(a.right, b.right) - Math.max(a.left, b.left)
        const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top)
        if (w > 2 && h > 2)
          add('overlap', label(kids[i]) + ' ' + box(a) + ' overlaps ' + label(kids[j]) + ' ' + box(b) + '.')
      }
  }

  const outline = []
  const LANDMARKS =
    /^(header|nav|main|section|article|aside|footer|form|h[1-6]|p|button|a|input|select|textarea|img|svg|label|li|table|figure|blockquote)$/
  let n = 0
  const walk = (el, depth) => {
    for (const child of el.children) {
      if (outline.length >= MAX_OUTLINE) return
      if (inSvg(child)) continue
      const cs = styles.get(child)
      if (!cs || !visible(child, cs)) continue
      n++
      const tag = child.tagName.toLowerCase()
      const text = clip(ownText(child), 40)
      const id = child.getAttribute('data-id') || child.id
      const meaningful = LANDMARKS.test(tag) || text || id || child.children.length > 1
      if (meaningful && tag !== 'svg') {
        const r = child.getBoundingClientRect()
        const role = child.getAttribute('role')
        outline.push(
          '  '.repeat(depth) +
            '- ' +
            tag +
            (role ? '[' + role + ']' : '') +
            ' ' +
            (id ? '#' + id : '@n' + n) +
            (text ? ' "' + text + '"' : '') +
            ' ' +
            box(r),
        )
        walk(child, depth + 1)
      } else if (tag === 'svg') {
        const r = child.getBoundingClientRect()
        outline.push(
          '  '.repeat(depth) + '- icon ' + (child.getAttribute('data-icon') || 'svg') + ' ' + box(r),
        )
      } else walk(child, depth)
    }
  }
  walk(body, 0)
  if (outline.length >= MAX_OUTLINE) outline.push('… (outline cut)')
  return { height, contentHeight, problems, outline }
}
