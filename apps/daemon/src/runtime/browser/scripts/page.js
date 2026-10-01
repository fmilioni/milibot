;(function () {
  var KEY = Symbol.for('milibot.browser')
  var VERSION = '@VERSION@'
  var m = window[KEY]
  if (m && m.version === VERSION) return m
  var prev = m
  m = {
    version: VERSION,
    refs: new Map(),
    ids: new WeakMap(),
    next: 0,
    docId: Math.random().toString(36).slice(2, 10),
  }
  if (prev) {
    m.refs = prev.refs
    m.ids = prev.ids
    m.next = prev.next
    m.docId = prev.docId
  }
  Object.defineProperty(window, KEY, { value: m, configurable: true })

  var SKIP = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEMPLATE: 1, HEAD: 1, META: 1, LINK: 1, BR: 0, SVG: 0 }
  var LEAF = {
    button: 1,
    link: 1,
    tab: 1,
    menuitem: 1,
    menuitemcheckbox: 1,
    menuitemradio: 1,
    option: 1,
    checkbox: 1,
    radio: 1,
    switch: 1,
    treeitem: 1,
    textbox: 1,
    searchbox: 1,
    combobox: 1,
    spinbutton: 1,
    slider: 1,
    img: 1,
    progressbar: 1,
    meter: 1,
    clickable: 1,
  }
  var INTERACTIVE = {
    button: 1,
    link: 1,
    tab: 1,
    menuitem: 1,
    menuitemcheckbox: 1,
    menuitemradio: 1,
    option: 1,
    checkbox: 1,
    radio: 1,
    switch: 1,
    treeitem: 1,
    textbox: 1,
    searchbox: 1,
    combobox: 1,
    spinbutton: 1,
    slider: 1,
    clickable: 1,
    row: 1,
    gridcell: 1,
    listitem: 1,
    cell: 1,
  }
  /** Roles named by their label, never by their content (which is what the user typed). */
  var FIELD = { textbox: 1, searchbox: 1, combobox: 1, spinbutton: 1, slider: 1, listbox: 1 }
  var KNOWN_ROLES = {
    alert: 1,
    alertdialog: 1,
    article: 1,
    banner: 1,
    button: 1,
    cell: 1,
    checkbox: 1,
    columnheader: 1,
    combobox: 1,
    complementary: 1,
    contentinfo: 1,
    dialog: 1,
    figure: 1,
    form: 1,
    grid: 1,
    gridcell: 1,
    group: 1,
    heading: 1,
    img: 1,
    link: 1,
    list: 1,
    listbox: 1,
    listitem: 1,
    main: 1,
    menu: 1,
    menubar: 1,
    menuitem: 1,
    menuitemcheckbox: 1,
    menuitemradio: 1,
    meter: 1,
    navigation: 1,
    option: 1,
    paragraph: 1,
    progressbar: 1,
    radio: 1,
    region: 1,
    row: 1,
    rowheader: 1,
    search: 1,
    searchbox: 1,
    slider: 1,
    spinbutton: 1,
    status: 1,
    switch: 1,
    tab: 1,
    table: 1,
    tablist: 1,
    tabpanel: 1,
    textbox: 1,
    toolbar: 1,
    tree: 1,
    treegrid: 1,
    treeitem: 1,
    image: 1,
  }
  var DIALOG_SELECTOR = '[role=dialog], [role=alertdialog], dialog[open], [aria-modal=true]'
  var ALERT_SELECTOR = '[role=alert], [role=status], [aria-live=assertive]'
  var EDITABLE_SELECTOR =
    'input:not([type]), input[type=text i], input[type=search i], input[type=email i], ' +
    'input[type=url i], input[type=tel i], input[type=password i], input[type=number i], textarea, ' +
    '[contenteditable=""], [contenteditable=true i], [contenteditable=plaintext-only i]'
  var CONTROL_SELECTOR =
    'input:not([type=hidden]), textarea, select, [contenteditable=""], [contenteditable=true], [role=textbox], [role=combobox], [role=searchbox]'
  // Portuguese on purpose: REMOVE_RE also matches PT/ES button labels on real pages.
  var REMOVE_RE =
    /(^|\b)(remove|remover|delete|excluir|apagar|clear|limpar|close|fechar|quitar|eliminar)\b|^[×✕✖x]$/i
  var EMAIL_RE = /[^\s<>()"',;]+@[^\s<>()"',;]+\.[a-z]{2,}/i

  function clean(s) {
    return (s || '').replace(/\s+/g, ' ').trim()
  }
  function clip(s, n) {
    return s.length > n ? s.slice(0, n - 1) + '…' : s
  }
  function fold(s) {
    return clean(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
  }

  function landmarkScoped(el) {
    for (var p = el.parentElement; p; p = p.parentElement) {
      var t = p.tagName
      if (t === 'ARTICLE' || t === 'ASIDE' || t === 'MAIN' || t === 'NAV' || t === 'SECTION') return true
    }
    return false
  }

  function inputRole(el) {
    var type = (el.getAttribute('type') || 'text').toLowerCase()
    if (type === 'hidden') return null
    if (type === 'checkbox') return 'checkbox'
    if (type === 'radio') return 'radio'
    if (type === 'button' || type === 'submit' || type === 'reset' || type === 'image' || type === 'file')
      return 'button'
    if (type === 'range') return 'slider'
    if (type === 'number') return 'spinbutton'
    if (type === 'search') return el.hasAttribute('list') ? 'combobox' : 'searchbox'
    return el.hasAttribute('list') ? 'combobox' : 'textbox'
  }

  function isEditableRoot(el) {
    return el.isContentEditable && (!el.parentElement || !el.parentElement.isContentEditable)
  }

  function roleOf(el) {
    var attr = clean(el.getAttribute('role')).split(' ')[0]
    if (attr === 'presentation' || attr === 'none') return ''
    if (attr === 'image') return 'img'
    if (attr && KNOWN_ROLES[attr]) return attr
    var t = el.tagName
    switch (t) {
      case 'A':
      case 'AREA':
        return el.hasAttribute('href') ? 'link' : ''
      case 'BUTTON':
      case 'SUMMARY':
        return 'button'
      case 'H1':
      case 'H2':
      case 'H3':
      case 'H4':
      case 'H5':
      case 'H6':
        return 'heading'
      case 'IMG':
        return el.getAttribute('alt') ? 'img' : ''
      case 'INPUT':
        return inputRole(el)
      case 'SELECT':
        return el.multiple || el.size > 1 ? 'listbox' : 'combobox'
      case 'TEXTAREA':
        return 'textbox'
      case 'UL':
      case 'OL':
      case 'MENU':
        return 'list'
      case 'LI':
        return 'listitem'
      case 'NAV':
        return 'navigation'
      case 'MAIN':
        return 'main'
      case 'HEADER':
        return landmarkScoped(el) ? '' : 'banner'
      case 'FOOTER':
        return landmarkScoped(el) ? '' : 'contentinfo'
      case 'ASIDE':
        return 'complementary'
      case 'FORM':
        return el.getAttribute('aria-label') || el.getAttribute('aria-labelledby') ? 'form' : ''
      case 'SECTION':
        return el.getAttribute('aria-label') || el.getAttribute('aria-labelledby') ? 'region' : ''
      case 'DIALOG':
        return 'dialog'
      case 'TABLE':
        return 'table'
      case 'TR':
        return 'row'
      case 'TD':
        return 'cell'
      case 'TH':
        return el.getAttribute('scope') === 'row' ? 'rowheader' : 'columnheader'
      case 'OPTION':
        return 'option'
      case 'FIELDSET':
        return 'group'
      case 'P':
        return 'paragraph'
      case 'ARTICLE':
        return 'article'
      case 'PROGRESS':
        return 'progressbar'
      case 'METER':
        return 'meter'
      case 'IFRAME':
      case 'FRAME':
        return 'iframe'
    }
    if (isEditableRoot(el)) return 'textbox'
    return ''
  }

  function textOf(el) {
    return clean(el.innerText !== undefined ? el.innerText : el.textContent)
  }

  function byIds(el, attr) {
    var ids = clean(el.getAttribute(attr))
    if (!ids) return ''
    var root = el.getRootNode ? el.getRootNode() : el.ownerDocument
    var doc = el.ownerDocument
    return clean(
      ids
        .split(' ')
        .map(function (id) {
          var t = (root.getElementById && root.getElementById(id)) || doc.getElementById(id)
          if (!t || t === el) return ''
          return t.getAttribute('aria-label') || textOf(t)
        })
        .join(' ')
    )
  }

  function contentName(el) {
    var text = textOf(el)
    if (text && el.tagName !== 'BUTTON' && el.getAttribute('role') !== 'button') {
      // A chip's name without its remove button ("Ana ×" → "Ana").
      var inner = el.querySelectorAll('button, [role=button]')
      for (var i = 0; i < inner.length; i++) {
        var bt = textOf(inner[i])
        if (bt && bt.length < text.length && text.slice(-bt.length) === bt)
          text = clean(text.slice(0, -bt.length))
      }
    }
    if (text) return text
    var labelled = el.querySelector('[aria-label]')
    if (labelled) return clean(labelled.getAttribute('aria-label'))
    var img = el.querySelector('img[alt]')
    if (img) return clean(img.getAttribute('alt'))
    var title = el.querySelector('title')
    return title ? clean(title.textContent) : ''
  }

  function placeholderOf(el) {
    return clean(
      el.getAttribute('placeholder') ||
        el.getAttribute('aria-placeholder') ||
        el.getAttribute('data-placeholder')
    )
  }

  /** Short text right before an unnamed field (a visual label that is not a <label>). */
  function nearbyLabel(el) {
    var node = el
    for (var depth = 0; node && depth < 3; depth++, node = node.parentElement) {
      for (
        var s = node.previousElementSibling, hops = 0;
        s && hops < 3;
        s = s.previousElementSibling, hops++
      ) {
        if (s.matches && s.matches(CONTROL_SELECTOR)) return ''
        if (s.querySelector && s.querySelector(CONTROL_SELECTOR)) return ''
        var text = textOf(s)
        if (text && text.length <= 40) return text
        if (text) return ''
      }
    }
    return ''
  }

  function fieldName(el) {
    var t = el.tagName
    if (el.labels && el.labels.length) {
      var n = clean(
        Array.prototype.map
          .call(el.labels, function (l) {
            return textOf(l)
          })
          .join(' ')
      )
      if (n) return n
    }
    if (t === 'INPUT') {
      var type = (el.getAttribute('type') || '').toLowerCase()
      if (type === 'submit' || type === 'button' || type === 'reset')
        return clean(el.value) || (type === 'submit' ? 'Submit' : '')
      if (type === 'image') return clean(el.getAttribute('alt')) || 'Submit'
    }
    return clean(el.getAttribute('title')) || placeholderOf(el) || nearbyLabel(el)
  }

  function nameOf(el, role) {
    var n = byIds(el, 'aria-labelledby') || clean(el.getAttribute('aria-label'))
    if (n) return n
    var t = el.tagName
    if (t === 'INPUT' || t === 'SELECT' || t === 'TEXTAREA' || FIELD[role]) return fieldName(el)
    if (t === 'IMG' || t === 'AREA') return clean(el.getAttribute('alt') || el.getAttribute('title'))
    if (t === 'IFRAME' || t === 'FRAME') return clean(el.getAttribute('title') || el.getAttribute('name'))
    if (t === 'FIELDSET') {
      var lg = el.querySelector('legend')
      if (lg) return textOf(lg)
    }
    if (t === 'TABLE') {
      var cap = el.querySelector('caption')
      if (cap) return textOf(cap)
    }
    if (role === 'dialog' || role === 'alertdialog') {
      var h = el.querySelector('h1, h2, h3, h4, h5, h6, [role=heading]')
      if (h) return textOf(h)
    }
    if (LEAF[role] || role === 'heading') n = contentName(el)
    return n || clean(el.getAttribute('title'))
  }

  /** Hint of a field: aria-describedby/aria-errormessage, else a placeholder the name does not repeat. */
  function hintOf(el, name) {
    var d = byIds(el, 'aria-describedby')
    if (el.getAttribute('aria-invalid') === 'true') d = byIds(el, 'aria-errormessage') || d
    if (d && fold(name).indexOf(fold(d)) !== -1) d = ''
    return d
  }

  function deepActive() {
    var a = document.activeElement
    for (var guard = 0; a && guard < 20; guard++) {
      if (a.shadowRoot && a.shadowRoot.activeElement) {
        a = a.shadowRoot.activeElement
        continue
      }
      if (a.tagName === 'IFRAME' || a.tagName === 'FRAME') {
        var d
        try {
          d = a.contentDocument
        } catch (e) {
          d = null
        }
        if (d && d.activeElement && d.activeElement !== d.body) {
          a = d.activeElement
          continue
        }
      }
      break
    }
    return a && a !== document.body && a !== document.documentElement ? a : null
  }

  function isInvalid(el) {
    if (el.getAttribute('aria-invalid') === 'true') return true
    try {
      return el.matches(':user-invalid')
    } catch (e) {
      return false
    }
  }

  function statesOf(el, role, active) {
    var s = []
    var checked = el.getAttribute('aria-checked')
    if (
      role === 'checkbox' ||
      role === 'radio' ||
      role === 'switch' ||
      role === 'menuitemcheckbox' ||
      role === 'menuitemradio'
    ) {
      if (checked === 'mixed') s.push('mixed')
      else if (checked === 'true' || (checked === null && el.checked)) s.push('checked')
      else s.push('unchecked')
    }
    var exp = el.getAttribute('aria-expanded')
    if (exp === 'true') s.push('expanded')
    else if (exp === 'false' && role !== 'combobox') s.push('collapsed')
    if (el.getAttribute('aria-selected') === 'true' || (el.tagName === 'OPTION' && el.selected))
      s.push('selected')
    var cur = el.getAttribute('aria-current')
    if (cur && cur !== 'false') s.push('current')
    if (el.getAttribute('aria-pressed') === 'true') s.push('pressed')
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') s.push('disabled')
    if (role === 'dialog' || role === 'alertdialog') {
      if (isModal(el)) s.push('modal')
    }
    if (FIELD[role] || el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
      if (
        el.tagName === 'TEXTAREA' ||
        (el.isContentEditable && el.tagName !== 'INPUT') ||
        el.getAttribute('aria-multiline') === 'true'
      )
        s.push('multiline')
      if (el.readOnly || el.getAttribute('aria-readonly') === 'true') s.push('readonly')
      if (isInvalid(el)) s.push('invalid')
    }
    if (active && (el === active || (el.shadowRoot && el.contains(active)))) s.push('focused')
    return s.length ? s.join(',') : undefined
  }

  function valueOf(el, role) {
    var t = el.tagName
    if (t === 'SELECT') {
      var labels = Array.prototype.filter
        .call(el.options, function (o) {
          return o.selected
        })
        .map(function (o) {
          return clean(o.label || o.text)
        })
      return labels.join(', ')
    }
    if (t === 'INPUT' || t === 'TEXTAREA') {
      var type = (el.getAttribute('type') || '').toLowerCase()
      if (
        type === 'checkbox' ||
        type === 'radio' ||
        type === 'submit' ||
        type === 'button' ||
        type === 'reset' ||
        type === 'image' ||
        type === 'file'
      )
        return undefined
      if (type === 'password') return el.value ? '••••' : ''
      return clip(el.value || '', 300)
    }
    if (el.isContentEditable) return clip(clean(el.innerText), 300)
    if (FIELD[role]) {
      var inner = el.querySelector('input:not([type=hidden]), textarea')
      if (inner) return clip(inner.value || '', 300)
    }
    var now = el.getAttribute('aria-valuetext') || el.getAttribute('aria-valuenow')
    return now ? clean(now) : undefined
  }

  function hrefOf(el) {
    var raw = el.getAttribute('href')
    if (!raw || raw === '#' || /^javascript:/i.test(raw)) return undefined
    try {
      var u = new URL(raw, el.ownerDocument.baseURI)
      var here = window.location
      var s = u.origin === here.origin ? u.pathname + u.search + u.hash : u.href
      if (u.origin === here.origin && u.pathname === here.pathname && u.search === here.search)
        s = u.hash || s
      return s.length > 100 ? undefined : s
    } catch (e) {
      return undefined
    }
  }

  function refFor(el) {
    var id = m.ids.get(el)
    if (!id) {
      m.next += 1
      id = 'e' + m.next
      m.ids.set(el, id)
      m.refs.set(id, new WeakRef(el))
    }
    return id
  }

  function intersect(a, b) {
    return { l: Math.max(a.l, b.l), t: Math.max(a.t, b.t), r: Math.min(a.r, b.r), b: Math.min(a.b, b.b) }
  }

  function clickableGeneric(el, style, parentPointer) {
    if (el.hasAttribute('onclick')) return true
    var ja = el.getAttribute('jsaction')
    if (ja && /(^|;|\s)click:/.test(ja)) return true
    var ti = el.getAttribute('tabindex')
    if (ti !== null && Number(ti) >= 0) return true
    return style.cursor === 'pointer' && !parentPointer
  }

  function shown(el) {
    if (el.checkVisibility && !el.checkVisibility({ visibilityProperty: true, opacityProperty: true }))
      return false
    if (el.closest && el.closest('[aria-hidden=true]')) return false
    var r = el.getBoundingClientRect()
    return r.width > 0 && r.height > 0
  }

  function isModal(el) {
    if (el.getAttribute('aria-modal') === 'true') return true
    try {
      return el.tagName === 'DIALOG' && el.matches(':modal')
    } catch (e) {
      return false
    }
  }

  /** Popup lists a field controls (its suggestions), never part of the field's own content. */
  function popupsOf(el) {
    var ids = clean((el.getAttribute('aria-controls') || '') + ' ' + (el.getAttribute('aria-owns') || ''))
    var out = []
    if (!ids) return out
    ids.split(' ').forEach(function (id) {
      var t = el.ownerDocument.getElementById(id)
      if (t) out.push(t)
    })
    return out
  }

  function editableOf(el) {
    var t = el.tagName
    if (t === 'TEXTAREA' || el.isContentEditable) return el
    if (t === 'INPUT')
      return inputRole(el) && ['textbox', 'searchbox', 'combobox', 'spinbutton'].indexOf(inputRole(el)) !== -1
        ? el
        : null
    return el.querySelector ? el.querySelector(EDITABLE_SELECTOR) : null
  }

  function chipName(chip) {
    var remove = null
    var buttons = chip.querySelectorAll('button, [role=button]')
    for (var i = 0; i < buttons.length; i++) {
      var bn = clean(
        buttons[i].getAttribute('aria-label') || buttons[i].getAttribute('title') || textOf(buttons[i])
      )
      if (REMOVE_RE.test(bn)) {
        remove = buttons[i]
        break
      }
    }
    var label = clean(chip.getAttribute('aria-label'))
    var name = label && !REMOVE_RE.test(label) ? label : textOf(chip)
    if (remove) {
      var rt = textOf(remove)
      if (rt && name.slice(-rt.length) === rt) name = clean(name.slice(0, -rt.length))
    }
    var mail = ''
    ;['data-hovercard-id', 'data-email', 'email', 'title', 'data-value'].some(function (a) {
      var v = chip.getAttribute(a) || ''
      var hit = EMAIL_RE.exec(v)
      if (hit) mail = hit[0]
      return !!hit
    })
    if (mail && name.indexOf(mail) === -1) name = name ? name + ' <' + mail + '>' : mail
    var invalid = chip.getAttribute('aria-invalid') === 'true' || !!chip.querySelector('[aria-invalid=true]')
    return { n: clip(name, 80), invalid: invalid }
  }

  /**
   * Chips (recipients, tags) that belong to a field: items next to its input inside the smallest box that
   * holds no other field, e.g. [chip "Ana"] [chip "Bia"] <input>. Suggestions it controls are excluded.
   */
  function chipsOf(el) {
    var editable = editableOf(el) || el
    var popups = popupsOf(editable).concat(popupsOf(el))
    var node = el
    for (var depth = 0; depth < 4; depth++) {
      var box = node.parentElement
      if (!box || box === document.body) break
      var r = roleOf(box)
      if (r === 'dialog' || r === 'alertdialog' || r === 'form' || r === 'main' || box.tagName === 'FORM')
        break
      var controls = box.querySelectorAll(CONTROL_SELECTOR)
      var other = false
      for (var i = 0; i < controls.length; i++) {
        var c = controls[i]
        if (c !== el && c !== editable && !el.contains(c) && !c.contains(el) && shown(c)) {
          other = true
          break
        }
      }
      if (other) break
      var items = []
      var seen = []
      var cands = box.querySelectorAll(
        '[role=option], [role=listitem], [role=row], [data-hovercard-id], button, [role=button]'
      )
      for (var j = 0; j < cands.length; j++) {
        var cand = cands[j]
        if (cand === el || cand.contains(el) || el.contains(cand)) continue
        if (
          popups.some(function (p) {
            return p.contains(cand)
          })
        )
          continue
        var tag = cand.tagName,
          cr = cand.getAttribute('role')
        var chip = cand
        if (tag === 'BUTTON' || cr === 'button') {
          var bn = clean(cand.getAttribute('aria-label') || cand.getAttribute('title') || textOf(cand))
          if (!REMOVE_RE.test(bn)) continue
          chip = cand.parentElement
          while (chip && chip !== box && textOf(chip) === textOf(cand)) chip = chip.parentElement
          if (!chip || chip === box) continue
        }
        if (
          seen.some(function (s) {
            return s.contains(chip)
          })
        )
          continue
        if (!shown(chip)) continue
        var info = chipName(chip)
        if (!info.n) continue
        seen = seen.filter(function (s) {
          return !chip.contains(s)
        })
        items = items.filter(function (it) {
          return !chip.contains(it.el)
        })
        seen.push(chip)
        items.push({ el: chip, n: info.n, invalid: info.invalid })
      }
      if (items.length)
        return items.map(function (it) {
          return it.invalid ? it.n + ' (invalid)' : it.n
        })
      node = box
    }
    return null
  }

  function isChipField(el, role) {
    return role === 'combobox' || role === 'textbox' || role === 'searchbox' || role === 'listbox'
  }

  m.snapshot = function (opts) {
    opts = opts || {}
    if (opts.start && m.next < opts.start - 1) m.next = opts.start - 1
    var full = !!opts.full
    var vw = window.innerWidth,
      vh = window.innerHeight
    var stats = { above: 0, below: 0, nodes: 0, refs: 0, truncated: false, counted: new WeakSet() }
    var active = deepActive()
    var focusNode = null
    var hoisted = new Set()
    var deadline = Date.now() + 2500

    function withRef(node, el) {
      node.ref = refFor(el)
      stats.refs++
      return node
    }
    var MAX_NODES = 60000

    function countOutside(rect, clipRect) {
      if (rect.bottom <= clipRect.t) stats.above++
      else if (rect.top >= clipRect.b) stats.below++
    }

    function walkChildren(parent, ctx, out) {
      var root = parent.shadowRoot || parent
      var kids = root.childNodes
      for (var i = 0; i < kids.length; i++) walk(kids[i], ctx, out)
    }

    function walkSlot(slot, ctx, out) {
      var nodes = slot.assignedNodes({ flatten: true })
      if (!nodes.length) return walkChildren(slot, ctx, out)
      for (var i = 0; i < nodes.length; i++) walk(nodes[i], ctx, out)
    }

    /** Field leaf: name, value, chips, placeholder and hint. */
    function fieldLeaf(el, role, leaf) {
      if (!FIELD[role] && el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA') return
      var ph = placeholderOf(el)
      if (ph && (!leaf.n || fold(leaf.n).indexOf(fold(ph)) === -1) && !leaf.v) leaf.ph = clip(ph, 80)
      var d = hintOf(el, leaf.n || '')
      if (d) leaf.d = clip(d, 150)
      if (isChipField(el, role)) {
        var ch = chipsOf(el)
        if (ch) leaf.ch = ch.slice(0, 20)
      }
    }

    function walk(node, ctx, out) {
      if (stats.nodes > MAX_NODES || (stats.nodes % 500 === 0 && Date.now() > deadline)) {
        stats.truncated = true
        return
      }
      if (node.nodeType === 3) {
        var text = node.nodeValue.replace(/\s+/g, ' ')
        if (!text.trim()) {
          if (text && out.length) out.push(' ')
          return
        }
        if (!full && !ctx.visible) {
          var owner = node.parentNode
          if (ctx.rect && owner && !stats.counted.has(owner)) {
            stats.counted.add(owner)
            countOutside(ctx.rect, ctx.clip)
          }
          return
        }
        out.push(text)
        return
      }
      if (node.nodeType !== 1) return
      stats.nodes++
      var el = node
      if (hoisted.has(el) && !ctx.hoist) return
      var tag = el.tagName
      if (SKIP[tag] === 1) return
      if (tag === 'SLOT') return walkSlot(el, ctx, out)
      if (tag === 'BR') {
        out.push({ r: '', b: 1 })
        return
      }
      if (el.getAttribute('aria-hidden') === 'true') return
      if (el.checkVisibility && !el.checkVisibility({ visibilityProperty: true })) {
        if (!(tag === 'INPUT' && el.labels && el.labels.length)) return
      }
      var cctxHoist = ctx.hoist ? { hoist: false } : null
      var style = el.ownerDocument.defaultView.getComputedStyle(el)
      if (style.display === 'contents')
        return walkChildren(el, cctxHoist ? Object.assign({}, ctx, cctxHoist) : ctx, out)
      var rect = el.getBoundingClientRect()
      var box = {
        l: rect.left + ctx.dx,
        t: rect.top + ctx.dy,
        r: rect.right + ctx.dx,
        b: rect.bottom + ctx.dy,
        top: rect.top + ctx.dy,
        bottom: rect.bottom + ctx.dy,
      }
      var clipRect = style.position === 'fixed' ? ctx.view : ctx.clip
      var visible = box.r > clipRect.l && box.l < clipRect.r && box.b > clipRect.t && box.t < clipRect.b
      // Inline content belongs to the text block around it: a paragraph cut by the viewport edge stays whole.
      if (!visible && ctx.visible && style.display.indexOf('inline') === 0 && style.position !== 'fixed')
        visible = true
      if (rect.width === 0 && rect.height === 0 && style.overflow === 'visible') visible = ctx.visible
      var role = roleOf(el)
      if (role === null) return
      if (tag === 'svg' || tag === 'SVG') {
        if (role === 'img' || el.getAttribute('aria-label')) {
          if (!full && !visible) return
          var sn = nameOf(el, 'img')
          if (sn) out.push({ r: 'img', n: clip(sn, 150) })
        }
        return
      }
      var pointer = style.cursor === 'pointer'
      if (role === 'iframe') {
        if (!full && !visible) {
          countOutside(box, clipRect)
          return
        }
        var frameNode = { r: 'iframe', n: clip(nameOf(el, role), 100) || undefined, b: 1, c: [] }
        var doc
        try {
          doc = el.contentDocument
        } catch (e) {
          doc = null
        }
        if (doc && doc.documentElement) {
          var fclip = intersect(clipRect, box)
          var fctx = {
            dx: box.l + el.clientLeft,
            dy: box.t + el.clientTop,
            visible: visible,
            clip: fclip,
            view: fclip,
            rect: box,
            pointer: false,
          }
          walkChildren(doc.body || doc.documentElement, fctx, frameNode.c)
        } else frameNode.x = 1
        out.push(frameNode)
        return
      }
      // A field or item that wraps other controls (an inner <input>, a chip's remove button) is listed as a
      // container so those controls get refs too.
      var isLeaf = !!LEAF[role]
      if (
        isLeaf &&
        role !== 'button' &&
        role !== 'link' &&
        tag !== 'INPUT' &&
        tag !== 'TEXTAREA' &&
        tag !== 'SELECT' &&
        !el.isContentEditable &&
        el.querySelector(
          FIELD[role]
            ? 'input:not([type=hidden]), textarea, button, [role=button], [role=option]'
            : 'button, [role=button], input:not([type=hidden])'
        )
      )
        isLeaf = false
      if (isLeaf) {
        if (!full && !visible) {
          countOutside(box, clipRect)
          return
        }
        var leaf = { r: role, n: clip(nameOf(el, role), 150) || undefined }
        if (INTERACTIVE[role]) withRef(leaf, el)
        var st = statesOf(el, role, active)
        if (st) leaf.st = st
        var v = valueOf(el, role)
        if (v !== undefined && v !== '') leaf.v = v
        if (role === 'link') leaf.h = hrefOf(el)
        fieldLeaf(el, role, leaf)
        if (style.display.indexOf('inline') === 0) leaf.i = 1
        if (active && (el === active || el.contains(active))) focusNode = leaf
        out.push(leaf)
        return
      }
      var childClip = clipRect
      if (style.overflowX !== 'visible' || style.overflowY !== 'visible') childClip = intersect(clipRect, box)
      var cctx = {
        dx: ctx.dx,
        dy: ctx.dy,
        visible: visible,
        clip: childClip,
        view: ctx.view,
        rect: box,
        pointer: pointer,
      }
      var node2 = { r: role, c: [] }
      var refsBefore = stats.refs
      walkChildren(el, cctx, node2.c)
      var hasContent = node2.c.some(function (c) {
        return typeof c === 'string' ? c.trim() !== '' : !(c.r === '' && c.b && !c.c)
      })
      if (
        !role &&
        stats.refs === refsBefore &&
        hasContent &&
        clickableGeneric(el, style, ctx.pointer) &&
        (full || visible)
      ) {
        var cl = withRef({ r: 'clickable', n: clip(contentName(el), 150) || undefined }, el)
        if (style.display.indexOf('inline') === 0) cl.i = 1
        if (active && (el === active || el.contains(active))) focusNode = cl
        out.push(cl)
        return
      }
      if (!hasContent && !(role && nameOf(el, role))) return
      if (role === 'row' || role === 'listitem' || role === 'cell' || role === 'gridcell') {
        if (clickableGeneric(el, style, ctx.pointer) || el.getAttribute('aria-selected') !== null)
          withRef(node2, el)
      } else if (INTERACTIVE[role]) withRef(node2, el)
      if (role) {
        var name =
          role === 'heading' ||
          role === 'paragraph' ||
          role === 'row' ||
          role === 'cell' ||
          role === 'gridcell' ||
          role === 'listitem' ||
          role === 'columnheader' ||
          role === 'rowheader' ||
          role === 'alert' ||
          role === 'status'
            ? clean(byIds(el, 'aria-labelledby') || el.getAttribute('aria-label'))
            : nameOf(el, role)
        if (name) node2.n = clip(name, 150)
        if (role === 'heading') node2.lv = Number(el.getAttribute('aria-level')) || Number(tag.charAt(1)) || 2
        var st2 = statesOf(el, role, active)
        if (st2) node2.st = st2
        if (FIELD[role]) {
          var v2 = valueOf(el, role)
          if (v2) node2.v = v2
          if (active && (el === active || el.contains(active)) && !focusNode) focusNode = node2
        }
      }
      if (style.display.indexOf('inline') !== 0) node2.b = 1
      else node2.i = 1
      if (!role && !node2.b) {
        for (var k = 0; k < node2.c.length; k++) out.push(node2.c[k])
        return
      }
      var only = node2.c.length === 1 ? node2.c[0] : null
      if (!role && only && typeof only === 'object' && only.b) {
        out.push(only)
        return
      }
      out.push(node2)
    }

    var view = { l: 0, t: 0, r: vw, b: vh }
    var rootCtx = { dx: 0, dy: 0, visible: true, clip: view, view: view, rect: null, pointer: false }
    var tree = []

    // Dialogs and alerts first: they are what the page is asking for right now.
    var dialogs = Array.prototype.filter.call(document.querySelectorAll(DIALOG_SELECTOR), function (d) {
      return shown(d) && roleOf(d) !== ''
    })
    dialogs = dialogs.filter(function (d) {
      return !dialogs.some(function (o) {
        return o !== d && o.contains(d)
      })
    })
    dialogs.sort(function (a, b) {
      var ra = roleOf(a) === 'alertdialog' ? 0 : isModal(a) ? 1 : 2
      var rb = roleOf(b) === 'alertdialog' ? 0 : isModal(b) ? 1 : 2
      return ra - rb
    })
    var modal = dialogs.some(isModal)
    dialogs.forEach(function (d) {
      hoisted.add(d)
    })
    var alerts = Array.prototype.filter.call(document.querySelectorAll(ALERT_SELECTOR), function (a) {
      if (
        dialogs.some(function (d) {
          return d.contains(a)
        })
      )
        return false
      var text = textOf(a)
      return text && text.length <= 500 && shown(a)
    })
    alerts = alerts.filter(function (a) {
      return !alerts.some(function (o) {
        return o !== a && o.contains(a)
      })
    })
    alerts.forEach(function (a) {
      hoisted.add(a)
    })
    dialogs.forEach(function (d) {
      var r = roleOf(d) === 'alertdialog' ? 'alertdialog' : 'dialog'
      var out = []
      walk(d, Object.assign({}, rootCtx, { hoist: true }), out)
      var dn =
        out.length === 1 && typeof out[0] === 'object' && out[0].r === r ? out[0] : { r: r, b: 1, c: out }
      if (!dn.n) {
        var title = nameOf(d, r)
        if (title) dn.n = clip(title, 150)
      }
      if (isModal(d) && (!dn.st || dn.st.indexOf('modal') === -1)) dn.st = dn.st ? dn.st + ',modal' : 'modal'
      tree.push(dn)
    })
    alerts.forEach(function (a) {
      var out = []
      walk(a, Object.assign({}, rootCtx, { hoist: true, visible: true }), out)
      var role = a.getAttribute('role') === 'status' ? 'status' : 'alert'
      var inner = out.length === 1 && typeof out[0] === 'object' && out[0].c ? out[0].c : out
      tree.push({ r: role, b: 1, c: inner })
    })
    var body = document.body || document.documentElement
    var behind = modal && !full
    if (!behind) walk(body, rootCtx, tree)
    var se = document.scrollingElement || document.documentElement
    return {
      url: location.href,
      title: document.title,
      docId: m.docId,
      next: m.next,
      vw: vw,
      vh: vh,
      scrollY: Math.round(se.scrollTop),
      scrollH: Math.round(se.scrollHeight),
      tree: tree,
      above: stats.above,
      below: stats.below,
      truncated: stats.truncated,
      focus: focusNode ? { r: focusNode.r, n: focusNode.n, ref: focusNode.ref } : null,
      behindModal: behind,
    }
  }

  function resolve(ref) {
    var w = m.refs.get(ref)
    var el = w && w.deref()
    if (!el || !el.isConnected) return null
    return el
  }

  function absRect(el) {
    var r = el.getBoundingClientRect()
    var x = r.left,
      y = r.top
    var win = el.ownerDocument.defaultView
    while (win && win !== window && win.frameElement) {
      var fe = win.frameElement
      var fr = fe.getBoundingClientRect()
      x += fr.left + fe.clientLeft
      y += fr.top + fe.clientTop
      win = fe.ownerDocument.defaultView
    }
    return { x: x, y: y, w: r.width, h: r.height }
  }

  function hitTest(x, y) {
    var doc = document,
      hit = doc.elementFromPoint(x, y),
      ox = 0,
      oy = 0
    for (;;) {
      while (hit && hit.shadowRoot) {
        var deeper = hit.shadowRoot.elementFromPoint(x - ox, y - oy)
        if (!deeper || deeper === hit) break
        hit = deeper
      }
      if (!hit || (hit.tagName !== 'IFRAME' && hit.tagName !== 'FRAME')) break
      var inner
      try {
        inner = hit.contentDocument
      } catch (e) {
        inner = null
      }
      if (!inner) break
      var fr = hit.getBoundingClientRect()
      ox += fr.left + hit.clientLeft
      oy += fr.top + hit.clientTop
      var next = inner.elementFromPoint(x - ox, y - oy)
      if (!next) break
      hit = next
    }
    return hit
  }

  function describe(el) {
    var role = roleOf(el) || el.tagName.toLowerCase()
    var name = clip(nameOf(el, role) || (FIELD[role] ? '' : contentName(el)), 60)
    var ref = m.ids.get(el)
    return role + (name ? ' "' + name + '"' : '') + (ref ? ' [' + ref + ']' : '')
  }

  function receives(el, hit) {
    if (!hit) return false
    if (el === hit || el.contains(hit) || (hit.contains(el) && hit.tagName === 'LABEL')) return true
    var label = hit.closest && hit.closest('label')
    if (label && label.control === el) return true
    return !!(
      el.labels &&
      Array.prototype.some.call(el.labels, function (l) {
        return l === hit || l.contains(hit)
      })
    )
  }

  m.point = function (ref) {
    var el = resolve(ref)
    if (!el) return { error: 'stale' }
    var target = el
    var r0 = el.getBoundingClientRect()
    if ((r0.width === 0 || r0.height === 0) && el.labels && el.labels.length) target = el.labels[0]
    var r = absRect(target)
    if (r.y < 0 || r.x < 0 || r.y + r.h > window.innerHeight || r.x + r.w > window.innerWidth) {
      target.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' })
      r = absRect(target)
    }
    if (r.w === 0 && r.h === 0) return { error: 'invisible', what: describe(el) }
    var points = [
      [0.5, 0.5],
      [0.25, 0.5],
      [0.75, 0.5],
      [0.5, 0.25],
      [0.5, 0.75],
    ]
    var hit = null
    for (var i = 0; i < points.length; i++) {
      var x = r.x + r.w * points[i][0],
        y = r.y + r.h * points[i][1]
      if (x < 0 || y < 0 || x >= window.innerWidth || y >= window.innerHeight) continue
      hit = hitTest(x, y)
      if (receives(target, hit) || receives(el, hit))
        return { x: Math.round(x), y: Math.round(y), what: describe(el) }
    }
    var cover = hit && hit.closest ? hit.closest(DIALOG_SELECTOR) : null
    if (!cover) {
      var modals = Array.prototype.filter.call(document.querySelectorAll(DIALOG_SELECTOR), function (d) {
        return isModal(d) && shown(d)
      })
      cover = modals[modals.length - 1] || hit
    }
    return {
      error: 'covered',
      what: describe(el),
      by: cover ? describe(cover) : 'something outside the viewport',
    }
  }

  function focusedWithin(el) {
    var a = deepActive()
    return !!a && (a === el || el.contains(a))
  }

  m.focus = function (ref, clear) {
    var el = resolve(ref)
    if (!el) return { error: 'stale' }
    var target = editableOf(el)
    if (!target) return { error: 'not_editable', what: describe(el) }
    var t = target.tagName
    target.scrollIntoView({ block: 'center', behavior: 'instant' })
    target.focus()
    if (t === 'INPUT' || t === 'TEXTAREA') {
      if (clear) target.select()
      else {
        var len = target.value.length
        try {
          target.setSelectionRange(len, len)
        } catch (e) {
          /* not every input type has a selection */
        }
      }
    } else {
      var sel = target.ownerDocument.getSelection()
      var range = target.ownerDocument.createRange()
      range.selectNodeContents(target)
      if (!clear) range.collapse(false)
      sel.removeAllRanges()
      sel.addRange(range)
    }
    var r = absRect(target)
    return {
      what: describe(el),
      hadText:
        t === 'INPUT' || t === 'TEXTAREA' ? target.value.length > 0 : clean(target.innerText).length > 0,
      focused: focusedWithin(target),
      x: Math.round(r.x + Math.min(r.w / 2, 40)),
      y: Math.round(r.y + r.h / 2),
    }
  }

  /** What a field holds after typing: value, chips, validity and the suggestions it shows. */
  m.fieldState = function (ref) {
    var el = resolve(ref)
    if (!el) return { error: 'stale' }
    var target = editableOf(el) || el
    var role = roleOf(el) || roleOf(target)
    var out = { what: describe(el), value: valueOf(target, roleOf(target) || role) || '' }
    var chips =
      isChipField(el, role) || isChipField(target, roleOf(target))
        ? chipsOf(el === target ? el : target)
        : null
    if (chips) out.chips = chips
    if (isInvalid(target) || isInvalid(el)) {
      out.invalid = true
      var msg =
        byIds(target, 'aria-errormessage') ||
        byIds(target, 'aria-describedby') ||
        target.validationMessage ||
        ''
      if (msg) out.message = clip(clean(msg), 200)
    }
    var popups = popupsOf(target).concat(popupsOf(el))
    var options = []
    popups.forEach(function (p) {
      if (!shown(p)) return
      Array.prototype.forEach.call(
        p.querySelectorAll('[role=option], option, [role=menuitem]'),
        function (o) {
          if (options.length < 8 && shown(o))
            options.push({
              ref: refFor(o),
              n: clip(nameOf(o, 'option'), 80),
              selected: o.getAttribute('aria-selected') === 'true',
            })
        }
      )
    })
    if (options.length) out.options = options
    out.next = m.next
    return out
  }

  function dialogSummary(d) {
    var role = roleOf(d) === 'alertdialog' ? 'alertdialog' : 'dialog'
    var title = clip(nameOf(d, role), 80)
    var text = textOf(d)
    var buttons = Array.prototype.filter.call(
      d.querySelectorAll('button, [role=button], a[href], input[type=submit], input[type=button]'),
      shown
    )
    var labels = buttons
      .slice(0, 6)
      .map(function (b) {
        var n = clip(nameOf(b, 'button') || contentName(b), 30)
        if (n) text = text.replace(n, ' ')
        return n ? '[' + n + '](' + refFor(b) + ')' : ''
      })
      .filter(Boolean)
    if (title && text.indexOf(title) === 0) text = text.slice(title.length)
    text = clip(clean(text), 300)
    var modal = isModal(d) ? ' (modal)' : ''
    var key = role + (title ? ' "' + title + '"' : '') + modal
    return { key: key, line: key + (text ? ': ' + text : '') + (labels.length ? ' ' + labels.join(' ') : '') }
  }

  /**
   * Dialogs, alerts and invalid fields on screen, one line each, to tell what an action caused. A dialog's
   * key is its role and title, so typing into it does not make it look new.
   */
  m.notices = function () {
    var items = []
    var dialogs = Array.prototype.filter.call(document.querySelectorAll(DIALOG_SELECTOR), shown)
    dialogs = dialogs.filter(function (d) {
      return !dialogs.some(function (o) {
        return o !== d && o.contains(d)
      })
    })
    dialogs.forEach(function (d) {
      if (roleOf(d)) items.push(dialogSummary(d))
    })
    Array.prototype.forEach.call(document.querySelectorAll(ALERT_SELECTOR), function (a) {
      var text = textOf(a)
      if (!text || text.length > 500 || !shown(a)) return
      if (
        dialogs.some(function (d) {
          return d.contains(a) && roleOf(d) === 'alertdialog'
        })
      )
        return
      var line = (a.getAttribute('role') === 'status' ? 'status' : 'alert') + ': ' + clip(text, 300)
      items.push({ key: line, line: line })
    })
    Array.prototype.forEach.call(document.querySelectorAll('[aria-invalid=true]'), function (f) {
      if (!shown(f) || items.length > 12) return
      var msg = byIds(f, 'aria-errormessage') || byIds(f, 'aria-describedby')
      var line = 'invalid field: ' + describe(f) + (msg ? ' — ' + clip(msg, 200) : '')
      items.push({ key: line, line: line })
    })
    return { items: items.slice(0, 12), next: m.next }
  }

  m.select = function (ref, values) {
    var el = resolve(ref)
    if (!el) return { error: 'stale' }
    if (el.tagName !== 'SELECT') return { error: 'not_select', what: describe(el) }
    var wanted = values.map(function (v) {
      return clean(String(v)).toLowerCase()
    })
    var picked = []
    Array.prototype.forEach.call(el.options, function (o) {
      var hit =
        wanted.indexOf(clean(o.value).toLowerCase()) !== -1 ||
        wanted.indexOf(clean(o.label || o.text).toLowerCase()) !== -1
      if (hit && (el.multiple || picked.length === 0)) picked.push(o)
    })
    if (!picked.length) {
      return {
        error: 'no_option',
        options: Array.prototype.map
          .call(el.options, function (o) {
            return clean(o.label || o.text)
          })
          .slice(0, 50),
      }
    }
    Array.prototype.forEach.call(el.options, function (o) {
      o.selected = picked.indexOf(o) !== -1
    })
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
    return {
      what: describe(el),
      selected: picked.map(function (o) {
        return clean(o.label || o.text)
      }),
    }
  }

  m.scrollInto = function (ref) {
    var el = resolve(ref)
    if (!el) return { error: 'stale' }
    el.scrollIntoView({ block: 'center', behavior: 'instant' })
    return { what: describe(el) }
  }

  m.hasText = function (text) {
    var needle = clean(text).toLowerCase()
    function inDoc(doc) {
      if (!doc || !doc.body) return false
      if (clean(doc.body.innerText).toLowerCase().indexOf(needle) !== -1) return true
      var frames = doc.querySelectorAll('iframe, frame')
      for (var i = 0; i < frames.length; i++) {
        var inner
        try {
          inner = frames[i].contentDocument
        } catch (e) {
          inner = null
        }
        if (inner && inDoc(inner)) return true
      }
      return false
    }
    return inDoc(document)
  }

  m.state = function () {
    return { url: location.href, title: document.title, docId: m.docId, ready: document.readyState }
  }

  return m
})()
