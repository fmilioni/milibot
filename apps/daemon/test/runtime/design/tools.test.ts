import { createHash } from 'node:crypto'

import type { ToolExecContext, ToolResult } from '@milibot/agent'
import { makeBot } from '@milibot/agent/testing'
import type { Message, WorkspaceEvent } from '@milibot/shared'
import { describe, expect, it, vi } from 'vitest'

import { defaultDesignAssets } from '../../../src/runtime/design/assets'
import type { FrameDraftPayload } from '../../../src/runtime/design/draft'
import { prepareFrameHtml } from '../../../src/runtime/design/html'
import type { DesignRenderBackend, RenderRequest } from '../../../src/runtime/design/render'
import { type DesignDeps, DesignService } from '../../../src/runtime/design/service'
import { extractSvg, partialSvg, sanitizeSvg } from '../../../src/runtime/design/svg'
import { completePathData, pathEnd } from '../../../src/runtime/design/svg-path'
import { DesignTools } from '../../../src/runtime/design/tools'
import type { VmController } from '../../../src/runtime/vm/controller'
import { openWorkspaceDb } from '../../../src/workspace-db/open'

describe('design tools', () => {
  class MemoryBlobs {
    readonly blobs = new Map<string, { bytes: Uint8Array; mediaType: string }>()
    async put(bytes: Uint8Array, mediaType: string) {
      const sha = createHash('sha256').update(bytes).digest('hex')
      this.blobs.set(sha, { bytes, mediaType })
      return sha
    }
    async read(sha: string) {
      return (await this.get(sha)).bytes
    }
    async get(sha: string) {
      const blob = this.blobs.get(sha)
      if (!blob) throw new Error('missing')
      return blob
    }
  }

  function setup(draw?: DesignDeps['draw']) {
    const db = openWorkspaceDb(':memory:')
    const renders: RenderRequest[] = []
    const content: { height?: number } = {}
    const render: DesignRenderBackend = {
      render: async (request) => {
        renders.push(request)
        return {
          height: request.height ?? content.height ?? 640,
          contentHeight: content.height ?? request.height ?? 640,
          problems: [],
          outline: ['- h1 @n1 "Hi" (0,0 100×20)'],
          png: null,
        }
      },
      pdf: async () => new Uint8Array(),
      available: () => false,
      close: async () => undefined,
    }
    const events: WorkspaceEvent[] = []
    const cards: Array<{ id: string; payload: unknown }> = []
    const bot = makeBot({ slug: 'lia' })
    const designs = new DesignService({
      db,
      vm: { status: () => ({ state: 'stopped' }), guest: async () => ({}) } as unknown as VmController,
      blobs: new MemoryBlobs(),
      render,
      renderBase: async () => 'http://10.0.2.2:1234',
      assets: defaultDesignAssets(),
      fontsDir: null,
      assertConversation: () => undefined,
      appendMessage: (m) => {
        cards.push({ id: `msg_${cards.length + 1}`, payload: m.payload })
        return { id: `msg_${cards.length}` } as Message
      },
      updateMessage: (id, patch) => {
        const card = cards.find((c) => c.id === id)
        if (card) card.payload = patch.payload
        return { id } as Message
      },
      emit: (event) => events.push(event),
      now: Date.now,
      ...(draw ? { draw } : {}),
    })
    const ctx: ToolExecContext = {
      bot,
      conversationId: 'cnv_1',
      turnId: 'trn_1',
      signal: new AbortController().signal,
    }
    const tools = new DesignTools({
      designs,
      getBot: () => bot,
      cardConversation: (_bot, id) => id ?? 'cnv_dm',
    })
    const call = async (name: string, args: Record<string, unknown>): Promise<ToolResult> =>
      tools.execute(ctx, { id: name, name, arguments: args })
    const text = (result: ToolResult) => (result.content[0] as { text: string }).text
    return { designs, call, text, events, cards, renders, ctx, content }
  }

  it('checks arguments and names the valid options', async () => {
    const { call, text } = setup()
    expect(text(await call('design_create', {}))).toMatch(/"name" is required/)
    await call('design_create', { name: 'App', themes: ['Light', 'Night'] })
    expect(
      text(await call('design_write_frame', { design: 'app', name: 'Home', width: 5, html: '' })),
    ).toMatch(/"width" must be 16/)
    expect(
      text(
        await call('design_write_frame', {
          design: 'App',
          name: 'Home',
          width: 390,
          html: 'x',
          theme: 'Blue',
        }),
      ),
    ).toMatch(/no theme "Blue" \(themes: Light, Night\)/)
    expect(text(await call('design_read', { design: 'Nope' }))).toMatch(/There is no design "Nope"/)
    expect(text(await call('design_frame', { design: 'App', frame: 'Home', action: 'fly' }))).toMatch(
      /There is no frame "Home"/,
    )
    await call('design_write_frame', {
      design: 'App',
      name: 'Home',
      width: 390,
      height: 844,
      html: '<h1>Hi</h1>',
    })
    expect(text(await call('design_frame', { design: 'App', frame: 'Home', action: 'fly' }))).toMatch(
      /"action" must be/,
    )
    expect(
      text(await call('design_screenshot', { design: 'App', frames: ['a', 'b', 'c', 'd', 'e'] })),
    ).toMatch(/at most 4 frames/)
    expect(text(await call('design_export', { design: 'App', format: 'svg', path: '/workspace/x' }))).toMatch(
      /"format" must be png, pdf or html/,
    )
    expect(text(await call('design_export', { design: 'App', format: 'pdf', path: '/etc/x.pdf' }))).toMatch(
      /under \/workspace/,
    )
  })

  it('places frames side by side, refuses moves onto another frame and keeps the card current', async () => {
    const { call, text, cards, events, renders } = setup()
    await call('design_create', {
      name: 'App',
      themes: ['Light'],
      tokens: [{ name: 'primary', value: '#0a7' }],
    })
    const home = text(
      await call('design_write_frame', {
        design: 'App',
        name: 'Home',
        width: 390,
        height: 844,
        html: '<h1>Hi</h1>',
      }),
    )
    expect(home).toMatch(/Added the frame "Home" \(dfr_\w+\) 390×844 at \(0, 0\)/)
    expect(home).toContain('No layout problems found.')
    expect(home).toContain('- h1 @n1 "Hi"')
    expect(renders[0]).toMatchObject({ width: 390, height: 844, screenshot: false })
    expect(renders[0]?.url).toMatch(/^http:\/\/10\.0\.2\.2:1234\/render\/[0-9a-f]{48}\/dfr_\w+$/)
    const profile = text(
      await call('design_write_frame', { design: 'App', name: 'Profile', width: 390, html: '<p>Me</p>' }),
    )
    expect(profile).toMatch(/390×auto \(640\) at \(470, 0\)/)
    expect(profile).toContain('Content height: 640px.')

    expect(
      text(await call('design_frame', { design: 'App', frame: 'Profile', action: 'move', x: 100, y: 0 })),
    ).toMatch(/Not moved: \(100, 0\) overlaps "Home"\. The nearest free spot is/)
    expect(
      text(await call('design_frame', { design: 'App', frame: 'Profile', action: 'move', x: 0, y: 1000 })),
    ).toBe('Moved "Profile" to (0, 1000).')
    await call('design_frame', { design: 'App', frame: 'Home', action: 'duplicate' })
    expect(
      text(await call('design_frame', { design: 'App', frame: 'Home copy', action: 'reorder', position: 0 })),
    ).toBe('Order now: Home copy, Home, Profile.')
    expect(cards).toEqual([
      { id: 'msg_1', payload: expect.objectContaining({ type: 'design', name: 'App', frameCount: 3 }) },
    ])
    expect(events.some((e) => e.type === 'design.presence' && e.payload.active)).toBe(true)
    const read = text(await call('design_read', { design: 'App' }))
    expect(read).toContain('Themes: Light (default)')
    expect(read).toContain('color-primary | color | #0a7 (all themes)')
    expect(read).toMatch(/- Home copy \(dfr_\w+\) 390×844 at \(\d+, \d+\) · theme Light/)
    expect(events.some((e) => e.type === 'design.presence' && e.payload.mode === 'read')).toBe(false)

    await call('design_read', { design: 'App', frame: 'Home' })
    await call('design_screenshot', { design: 'App', frames: ['Profile'] })
    const reads = events.flatMap((e) =>
      e.type === 'design.presence' && e.payload.mode === 'read'
        ? [[e.payload.frameId, e.payload.active]]
        : [],
    )
    const ids = Object.fromEntries(
      events.flatMap((e) =>
        e.type === 'design.frame.updated' ? [[e.payload.frame.name, e.payload.frame.id]] : [],
      ),
    )
    expect(reads).toEqual([
      [ids.Home, true],
      [ids.Home, false],
      [ids.Profile, true],
      [ids.Profile, false],
    ])
  })

  it('deletes a design when the bot asks, marking its card removed', async () => {
    const { call, text, cards, events, designs } = setup()
    await call('design_create', { name: 'App', themes: ['Light'] })
    await call('design_write_frame', { design: 'App', name: 'Home', width: 390, html: '<p>Hi</p>' })
    expect(text(await call('design_delete', { design: 'app' }))).toMatch(
      /^Deleted the design "App" \(dsg_\w+\)\.$/,
    )
    expect(designs.store.rows()).toEqual([])
    expect(events.some((e) => e.type === 'design.deleted')).toBe(true)
    expect(cards.at(-1)?.payload).toMatchObject({ type: 'design', removed: true })
    expect(text(await call('design_delete', { design: 'App' }))).toMatch(/There is no design "App"/)
  })

  it('archives a design out of the list, finds it by exact name and refuses changes until unarchived', async () => {
    const { call, text, cards } = setup()
    await call('design_create', { name: 'Old landing', themes: ['Light'] })
    await call('design_create', { name: 'App', themes: ['Light'] })
    expect(text(await call('design_archive', { design: 'old landing' }))).toMatch(
      /^Archived the design "Old landing"/,
    )
    const oldCard = () => cards.find((c) => (c.payload as { name?: string }).name === 'Old landing')?.payload
    expect(oldCard()).toMatchObject({ type: 'design', archived: true })
    const listed = text(await call('design_list', {}))
    expect(listed).toContain('App')
    expect(listed).not.toContain('Old landing')
    expect(text(await call('design_list', { archived: true }))).toMatch(/Old landing .* · archived/)
    expect(text(await call('design_read', { design: 'old' }))).toMatch(/There is no design "old"/)
    expect(text(await call('design_read', { design: 'Old landing' }))).toMatch(/^Design "Old landing"/)
    expect(
      text(
        await call('design_write_frame', {
          design: 'Old landing',
          name: 'Home',
          width: 390,
          html: '<p>Hi</p>',
        }),
      ),
    ).toMatch(/is archived; unarchive it with design_archive first/)
    await call('design_archive', { design: 'Old landing', archived: false })
    expect(oldCard()).not.toHaveProperty('archived')
    expect(text(await call('design_list', {}))).toContain('Old landing')
  })

  it('grows a screen whose content runs past its height, but never a slide or a printed page', async () => {
    const { call, text, designs, content } = setup()
    await call('design_create', { name: 'Site', themes: ['Light'] })
    await call('design_write_frame', {
      design: 'Site',
      name: 'Below',
      width: 1440,
      height: 900,
      x: 0,
      y: 1000,
      html: '<p>Below</p>',
    })
    content.height = 1673
    const landing = text(
      await call('design_write_frame', {
        design: 'Site',
        name: 'Landing',
        width: 1440,
        height: 900,
        x: 0,
        y: 0,
        html: '<main>Long</main>',
      }),
    )
    expect(landing).toMatch(/Added the frame "Landing" \(dfr_\w+\) 1440×auto \(1673\) at \((?!0, 0)/)
    expect(landing).toContain('The content (1673px) is taller than the 900px given, so the frame now grows')
    expect(landing).toContain('moved to')
    const design = designs.store.rows({})[0]?.id as string
    const frame = designs.store.frames(design).find((f) => f.name === 'Landing')
    expect(frame).toMatchObject({ height: null, measured_height: 1673 })
    const revision = designs.store.revisions(design)[0]
    const snapshot = designs.store.revision(design, revision?.id as string)?.snapshot
    expect(snapshot).toMatchObject({ kind: 'frame', after: { name: 'Landing', height: null } })

    content.height = 1500
    const slide = text(
      await call('design_write_frame', {
        design: 'Site',
        name: 'Slide',
        width: 1920,
        height: 1080,
        html: '<h1>Title</h1>',
      }),
    )
    expect(slide).toMatch(/1920×1080 at/)
    expect(slide).not.toContain('grows')
    content.height = 905
    const mobile = text(
      await call('design_write_frame', {
        design: 'Site',
        name: 'Phone',
        width: 390,
        height: 900,
        html: '<p>x</p>',
      }),
    )
    expect(mobile).toMatch(/390×900 at/)
  })

  it('shows a frame while it is written, where it will go, until the write lands', async () => {
    const { call, designs, events, ctx } = setup()
    await call('design_create', { name: 'App', themes: ['Light'] })
    await call('design_write_frame', {
      design: 'App',
      name: 'Home',
      width: 390,
      height: 844,
      html: '<h1>Hi</h1>',
    })
    const draftCtx = { bot: ctx.bot, conversationId: 'cnv_1', turnId: 'trn_1', laneKey: ctx.bot.id }
    const input = JSON.stringify({
      design: 'App',
      name: 'Profile',
      width: 390,
      html: '<section class="p-4 bg-black"><h2 class="text-white">About</h2><p class="text-sm">Hello',
    })
    designs.drafts.update(draftCtx, input.slice(0, -2))
    await vi.waitFor(() => expect(events.some((e) => e.type === 'design.frame.draft')).toBe(true))
    const draft = events.find((e) => e.type === 'design.frame.draft')?.payload as FrameDraftPayload
    expect(draft).toMatchObject({ frameId: null, name: 'Profile', x: 470, y: 0, width: 390, height: null })
    expect(draft.html).toMatch(/^<!doctype html>/)
    expect(draft.html).toContain('About')
    expect(draft.html).toMatch(/\.bg-black \{/)

    const replace = JSON.stringify({ design: 'App', name: 'Home', width: 390, height: 844, html: '<h1>Hi' })
    designs.drafts.update({ ...draftCtx, toolCallId: 'toolu_home' }, replace)
    await vi.waitFor(() =>
      expect(events.filter((e) => e.type === 'design.frame.draft').length).toBeGreaterThan(1),
    )
    const home = events.filter((e) => e.type === 'design.frame.draft').at(-1)?.payload as FrameDraftPayload
    expect(home).toMatchObject({ name: 'Home', x: 0, y: 0, height: 844 })
    expect(home.frameId).toMatch(/^dfr_/)

    await call('design_write_frame', {
      design: 'App',
      name: 'Home',
      width: 390,
      height: 844,
      html: '<h1>Hi</h1>',
    })
    const cleared = events.filter((e) => e.type === 'design.frame.draft.cleared').map((e) => e.payload)
    expect(cleared).toEqual([{ designId: draft.designId, draftId: 'trn_1:toolu_home' }])
    designs.drafts.turnEnded('trn_1')
    expect(events.filter((e) => e.type === 'design.frame.draft.cleared')).toHaveLength(2)
  })

  it('shows the draft before its size arrives, when the model writes the keys in alphabetical order', async () => {
    const { call, designs, events, ctx } = setup()
    await call('design_create', { name: 'Blank', themes: ['Light'] })
    await call('design_create', { name: 'App', themes: ['Light'] })
    await call('design_write_frame', {
      design: 'App',
      name: 'Home',
      width: 390,
      height: 844,
      html: '<h1>Hi</h1>',
    })
    const draftCtx = { bot: ctx.bot, conversationId: 'cnv_1', turnId: 'trn_1', laneKey: ctx.bot.id }
    const drafts = () =>
      events.filter((e) => e.type === 'design.frame.draft').map((e) => e.payload as FrameDraftPayload)

    const cut = (design: string) =>
      JSON.stringify({
        css: '',
        design,
        html: '<section><h2>About</h2><p>Hello',
        name: 'Profile',
        width: 800,
      }).split('<p>Hello')[0] as string
    designs.drafts.update(draftCtx, cut('App'))
    await vi.waitFor(() => expect(drafts()).toHaveLength(1))
    expect(drafts()[0]).toMatchObject({ name: '', width: 390, height: 844 })
    expect(drafts()[0]?.html).toContain('About')

    designs.drafts.update({ ...draftCtx, turnId: 'trn_2' }, cut('Blank'))
    await vi.waitFor(() => expect(drafts()).toHaveLength(2))
    expect(drafts()[1]).toMatchObject({ width: 1440, height: 900 })
  })

  it('sizes the draft of a phone frame as a phone before its width arrives', async () => {
    const { call, designs, events, ctx } = setup()
    await call('design_create', { name: 'Site', themes: ['Light'] })
    await call('design_write_frame', {
      design: 'Site',
      name: 'Home — desktop',
      width: 1440,
      html: '<h1>Hi</h1>',
    })
    const drafts = () =>
      events.filter((e) => e.type === 'design.frame.draft').map((e) => e.payload as FrameDraftPayload)
    const cut = (name: string, turnId: string) => {
      const json = JSON.stringify({
        design: 'Site',
        name,
        html: '<section><h2>About</h2><p>Hello',
        width: 390,
      })
      designs.drafts.update(
        { bot: ctx.bot, conversationId: 'cnv_1', turnId, laneKey: ctx.bot.id },
        json.split('<p>Hello')[0] as string,
      )
    }

    cut('Home — Mobile', 'trn_1')
    await vi.waitFor(() => expect(drafts()).toHaveLength(1))
    expect(drafts()[0]).toMatchObject({ name: 'Home — Mobile', width: 390 })

    // Portuguese on purpose: a pt frame name also reads as a phone frame.
    cut('Home — celular', 'trn_2')
    await vi.waitFor(() => expect(drafts()).toHaveLength(2))
    expect(drafts()[1]).toMatchObject({ width: 390 })

    cut('Pricing', 'trn_3')
    await vi.waitFor(() => expect(drafts()).toHaveLength(3))
    expect(drafts()[2]).toMatchObject({ width: 1440, height: null })
  })

  it('edits frames by exact text and merges tokens', async () => {
    const { call, text } = setup()
    await call('design_create', { name: 'App', themes: ['Light', 'Night'] })
    await call('design_write_frame', {
      design: 'App',
      name: 'Home',
      width: 390,
      height: 844,
      html: '<h1>Hi</h1>',
    })
    expect(
      text(
        await call('design_edit_frame', {
          design: 'App',
          frame: 'Home',
          edits: [{ old_text: 'Hi', new_text: 'Hey' }],
        }),
      ),
    ).toMatch(/^Edited "Home" \(1 change\)/)
    expect(
      text(
        await call('design_edit_frame', {
          design: 'App',
          frame: 'Home',
          edits: [{ old_text: 'Hi', new_text: 'x' }],
        }),
      ),
    ).toMatch(/old_text was not found/)
    const tokens = text(
      await call('design_set_tokens', {
        design: 'App',
        rename_themes: { Night: 'Dark' },
        tokens: [{ name: 'bg', values: { Light: '#fff', Dark: '#000' } }],
        fonts: ['Fraunces'],
      }),
    )
    expect(tokens).toContain('Changed themes Light, Dark; tokens color-bg; fonts Fraunces.')
    expect(tokens).toContain('color-bg | color | #fff | #000')
    expect(text(await call('design_set_tokens', { design: 'App', fonts: ['Bad<Font>'] }))).toMatch(
      /not a font family/,
    )
  })

  describe('drawings', () => {
    const box = { width: 200, height: 200 }

    it('keeps only the vector subset of an SVG, as well-formed XML sized to the frame', () => {
      const clean = sanitizeSvg(
        '<svg viewBox="0 0 100 50" width="10" fill="none" onload="x()"><script>x()</script><style>*{}</style>' +
          '<defs><linearGradient id="g"><stop offset="0" stop-color="#f00"/></linearGradient></defs>' +
          '<rect fill="url(#g)" x="1" y="2" width="10" height="5" onclick="y"/>' +
          '<path fill="url(http://evil)" stroke="#0a7" d="M10 10 L 40 10"/>' +
          '<image href="http://x/a.png"/><foreignObject><div>hi</div></foreignObject><use href="#g"/>' +
          '<text x="1" y="2" data-x="1">A &lt; B</text></svg>',
        box,
      )
      expect(clean?.svg).toBe(
        '<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 100 50" width="200" height="200">' +
          '<defs><linearGradient id="g"><stop offset="0" stop-color="#f00"/></linearGradient></defs>' +
          '<rect fill="url(#g)" x="1" y="2" width="10" height="5"/><path stroke="#0a7" d="M10 10 L 40 10"/>' +
          '<text x="1" y="2">A &lt; B</text></svg>',
      )
      expect(sanitizeSvg('<svg viewBox="bad"><circle cx="1" cy="1" r="1"/></svg>', box)?.viewBox).toEqual({
        x: 0,
        y: 0,
        ...box,
      })
      expect(sanitizeSvg('<svg><script/></svg>', box)).toBeNull()
      expect(extractSvg('Here:\n```svg\n<svg><rect/></svg>\n```')).toBe('<svg><rect/></svg>')
      expect(extractSvg('<svg><rect/>')).toBeNull()
    })

    it('shows a drawing while it streams: whole commands of the path being written, and where the pen is', () => {
      expect(completePathData('M10 10 L20 2')).toBe('')
      expect(completePathData('M10 10 L20 20 C1 2 3 4 5')).toBe('M10 10 L20 20')
      expect(completePathData('M0 0a5 5 0 01 10 0 l3')).toBe('M0 0a5 5 0 01 10 0')
      expect(pathEnd('M10 10 l5 5 h10 v-3')).toEqual({ x: 25, y: 12 })
      expect(pathEnd('M10 10 L20 20 Z')).toEqual({ x: 10, y: 10 })
      expect(pathEnd('M0 0a5 5 0 1 0 10 0')).toEqual({ x: 10, y: 0 })

      const svg =
        '<svg viewBox="0 0 100 50"><rect fill="#111" x="0" y="0" width="10" height="5"/><path fill="#0a7" d="M10 10 C 20 20 30 30 40 10 L 50 20"/></svg>'
      const at = (text: string) => partialSvg(svg.slice(0, svg.indexOf(text) + text.length), box)
      expect(partialSvg('<svg viewBox="0 0', box)).toBeNull()
      const growing = at('40 10 L 5')
      expect(growing?.svg).toContain('<path fill="#0a7" d="M10 10 C 20 20 30 30 40 10"/>')
      expect(growing?.pen).toEqual({ x: 80, y: 70 })
      expect(at('<path fill="#0a')?.svg).not.toContain('<path')
      expect(at('</svg>')?.pen).toEqual({ x: 100, y: 90 })
    })

    function drawer() {
      const calls: Array<{ purpose: string; prompt: string; turnId: string | null | undefined }> = []
      let answer: (text: string, stopReason?: string) => void = () => undefined
      let stream: ((delta: string) => void) | undefined
      const draw: NonNullable<DesignDeps['draw']> = {
        model: async () => ({
          kind: 'native',
          provider: {} as never,
          providerId: 'p',
          model: 'm',
          effort: 'high',
        }),
        writeText: (request) => {
          calls.push({ purpose: request.purpose, prompt: request.prompt, turnId: request.turnId })
          stream = request.onText
          return new Promise((resolve, reject) => {
            answer = (text, stopReason) => resolve({ text, ...(stopReason ? { stopReason } : {}) })
            request.signal?.addEventListener('abort', () => reject(new Error('aborted')))
          })
        },
      }
      return {
        draw,
        calls,
        finish: (text: string, stopReason?: string) => answer(text, stopReason),
        stream: (d: string) => stream?.(d),
      }
    }

    const LOGO =
      '<svg viewBox="0 0 64 64"><circle fill="#0a7" cx="32" cy="32" r="20"/><path fill="#fff" d="M20 32 L44 32"/></svg>'

    it('draws in the background, streams the pen, then every frame placing the drawing gets it', async () => {
      const pen = drawer()
      const { call, text, designs, events } = setup(pen.draw)
      await call('design_create', { name: 'Brand', themes: ['Light'] })
      const started = text(
        await call('design_draw', {
          design: 'Brand',
          name: 'Logo',
          prompt: 'A round green mark with a white bar, flat, #00aa77',
          width: 256,
          height: 256,
        }),
      )
      expect(started).toMatch(/Started drawing "Logo" \(dfr_\w+\) 256×256 at \(0, 0\) in the background/)
      expect(pen.calls).toEqual([
        { purpose: 'design_draw', prompt: expect.stringContaining('Canvas: 256×256 px.'), turnId: 'trn_1' },
      ])
      const header = text(
        await call('design_write_frame', {
          design: 'Brand',
          name: 'Header',
          width: 800,
          height: 120,
          html: '<header><img data-art="logo" class="h-10 w-auto" alt="Brand"></header>',
        }),
      )
      expect(header).toContain('"logo" is still being drawn')
      expect(text(await call('design_read', { design: 'Brand' }))).toMatch(
        /- Logo \(dfr_\w+\) 256×256 at .* · art · drawing/,
      )
      expect(
        text(await call('design_write_frame', { design: 'Brand', name: 'Logo', width: 100, html: 'x' })),
      ).toMatch(/"Logo" is an art frame/)
      expect(
        text(
          await call('design_draw', {
            design: 'Brand',
            name: 'Logo',
            prompt: 'x'.repeat(30),
            width: 64,
            height: 64,
          }),
        ),
      ).toMatch(/still being drawn/)

      pen.stream(LOGO.slice(0, LOGO.indexOf('<path') + 20))
      await vi.waitFor(() => expect(events.some((e) => e.type === 'design.frame.draft')).toBe(true))
      const draft = events.find((e) => e.type === 'design.frame.draft')?.payload as FrameDraftPayload
      expect(draft).toMatchObject({ draftId: expect.stringMatching(/^art:dfr_/), width: 256, height: 256 })
      expect(draft.art?.pen).toEqual({ x: 128, y: 128 })
      expect(draft.html).toContain('<circle fill="#0a7" cx="32" cy="32" r="20"/>')

      const headerId = designs.store
        .frames(designs.store.rows({})[0]?.id as string)
        .find((f) => f.name === 'Header')?.id
      const before = events.length
      pen.finish(`Here it is:\n${LOGO}`)
      await designs.idle()
      const logo = designs.store.frames(draft.designId).find((f) => f.name === 'Logo')
      expect(logo).toMatchObject({
        art_status: 'ready',
        html: expect.stringMatching(/^<img src="asset:[0-9a-f]{64}"/),
      })
      const later = events.slice(before)
      expect(later.some((e) => e.type === 'design.frame.draft.cleared')).toBe(true)
      expect(later.some((e) => e.type === 'design.frame.updated' && e.payload.frame.id === headerId)).toBe(
        true,
      )
      const compiled = await designs.compileRow(
        designs.store.row(draft.designId) as never,
        designs.store.frame(headerId as string) as never,
      )
      expect(compiled.html).toContain('src="data:image/svg+xml;base64,')
      expect(compiled.problems).toEqual([])
      expect(text(await call('design_list', {}))).toContain(
        'Drawing finished meanwhile: "Logo" in "Brand" is ready.',
      )
      expect(text(await call('design_list', {}))).not.toContain('Drawing finished')
    })

    it('reports a failed drawing on the next design call and lets it be drawn again', async () => {
      const pen = drawer()
      const { call, text, designs } = setup(pen.draw)
      await call('design_create', { name: 'Brand', themes: ['Light'] })
      await call('design_draw', {
        design: 'Brand',
        name: 'Mascot',
        prompt: 'A friendly fox, flat, orange',
        width: 400,
        height: 400,
      })
      pen.finish('I cannot draw that.')
      await designs.idle()
      expect(text(await call('design_read', { design: 'Brand' }))).toMatch(
        /Drawing "Mascot" in "Brand" failed \(the answer had no SVG\); draw it again once/,
      )
      expect(text(await call('design_read', { design: 'Brand' }))).toMatch(
        /· art · failed: the answer had no SVG/,
      )
      expect(
        text(
          await call('design_draw', {
            design: 'Brand',
            name: 'mascot',
            prompt: 'A friendly fox, flat, orange',
            width: 400,
            height: 400,
          }),
        ),
      ).toMatch(/Started drawing "mascot"/)
      expect(designs.store.frames(designs.store.rows({})[0]?.id as string)).toHaveLength(1)
    })

    it('shows a neutral block, never a broken image, for a drawing that does not exist yet', async () => {
      const { html, problems } = prepareFrameHtml('<img data-art="Later" class="size-8">', { Later: null })
      expect(html).toMatch(/^<img data-art="Later" class="size-8" src="data:image\/svg\+xml,/)
      expect(problems.map((p) => p.kind)).toEqual(['unknown_art'])
    })

    it('redraws from the current drawing, so the brief only says what changes', async () => {
      const pen = drawer()
      const { call, designs } = setup(pen.draw)
      await call('design_create', { name: 'Brand', themes: ['Light'] })
      const draw = (prompt: string) =>
        call('design_draw', { design: 'Brand', name: 'Scene', prompt, width: 64, height: 64 })
      await draw('A green hill under a sun, flat, #0a7 and #fc0')
      pen.finish(LOGO)
      await designs.idle()
      expect(pen.calls[0]?.prompt).not.toContain('Current drawing')
      await draw('Add a small dark figure on the hill, #111')
      expect(pen.calls[1]?.prompt).toContain('Current drawing (the starting point')
      expect(pen.calls[1]?.prompt).toContain('<circle fill="#0a7" cx="32" cy="32" r="20"/>')
      expect(pen.calls[1]?.prompt).toMatch(/Brief:\nAdd a small dark figure/)
    })

    it('says when the model spent its output limit reasoning', async () => {
      const pen = drawer()
      const { call, text, designs } = setup(pen.draw)
      await call('design_create', { name: 'Brand', themes: ['Light'] })
      await call('design_draw', {
        design: 'Brand',
        name: 'Mark',
        prompt: 'A bold tide symbol, flat, #153F39',
        width: 512,
        height: 512,
      })
      pen.finish('', 'max_tokens')
      await designs.idle()
      expect(text(await call('design_read', { design: 'Brand' }))).toContain(
        'failed: the model spent its whole output limit reasoning and wrote no SVG',
      )
    })

    it('stops the drawing when its frame or design goes, and renames the frames placing it', async () => {
      const pen = drawer()
      const { call, text, designs } = setup(pen.draw)
      await call('design_create', { name: 'Brand', themes: ['Light'] })
      await call('design_draw', {
        design: 'Brand',
        name: 'Logo',
        prompt: 'A round green mark, flat',
        width: 64,
        height: 64,
      })
      await call('design_write_frame', {
        design: 'Brand',
        name: 'Header',
        width: 400,
        height: 80,
        html: '<img data-art="Logo">',
      })
      expect(
        text(await call('design_frame', { design: 'Brand', frame: 'Logo', action: 'rename', name: 'Mark' })),
      ).toBe('Renamed "Logo" to "Mark". Updated data-art in 1 frame.')
      const id = designs.store.rows({})[0]?.id as string
      expect(designs.store.frames(id).find((f) => f.name === 'Header')?.html).toBe('<img data-art="Mark">')
      await call('design_frame', { design: 'Brand', frame: 'Mark', action: 'delete' })
      pen.finish(LOGO)
      await designs.idle()
      expect(designs.store.frames(id).map((f) => f.name)).toEqual(['Header'])
      expect(designs.artwork?.isDrawing('x')).toBe(false)
    })

    it('refuses to draw without a model and caps the drawings in progress per bot', async () => {
      const pen = drawer()
      const { call, text } = setup(pen.draw)
      await call('design_create', { name: 'Brand', themes: ['Light'] })
      const draw = (name: string) =>
        call('design_draw', {
          design: 'Brand',
          name,
          prompt: 'A simple flat shape in teal',
          width: 64,
          height: 64,
        })
      expect(
        text(
          await call('design_draw', { design: 'Brand', name: 'X', prompt: 'short', width: 64, height: 64 }),
        ),
      ).toMatch(/"prompt" must be 20 to 2000/)
      for (const name of ['A', 'B', 'C']) await draw(name)
      expect(text(await draw('D'))).toMatch(/already have 3 drawings in progress/)
      const { call: call2, text: text2 } = setup()
      await call2('design_create', { name: 'Brand', themes: ['Light'] })
      expect(
        text2(
          await call2('design_draw', {
            design: 'Brand',
            name: 'A',
            prompt: 'x'.repeat(30),
            width: 64,
            height: 64,
          }),
        ),
      ).toMatch(/drawing is not available/)
    })
  })
})
