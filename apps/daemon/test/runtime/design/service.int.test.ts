import { existsSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { DefaultAgentHost } from '@milibot/agent'
import type { CompletionRequest } from '@milibot/agent/llm'
import { DRAW_PROMPT_MARKER } from '@milibot/agent/prompts'
import { type FakeStep, solidPng } from '@milibot/agent/testing'
import type {
  Design,
  DesignDetail,
  DesignFrame,
  DesignFrameHtml,
  DesignFrameSource,
  DesignPayload,
  DesignRevision,
  Message,
  ToolCallRow,
  WorkspaceEvent,
} from '@milibot/shared'
import { afterEach, describe, expect, it } from 'vitest'

import type { DesignRenderBackend, RenderRequest } from '../../../src/runtime/design/render'
import type { WorkspaceRuntime } from '../../../src/runtime/runtime'
import { ZipWriter } from '../../../src/util/zip'
import type { FakeGuest } from '../../support/fake-guest'
import {
  bootRuntime,
  type RuntimeHarness,
  stopRuntimes,
  TEST_WORKSPACE_ID,
} from '../../support/runtime-harness'
import { useTempDir } from '../../support/temp'

let h: RuntimeHarness
let runtime: WorkspaceRuntime
let host: DefaultAgentHost
let events: WorkspaceEvent[]
/** What the drawing side call of design_draw answers. */
let drawing: FakeStep = { text: '' }
let botId: string
let dm: string
let requests: CompletionRequest[]
let renders: RenderRequest[]
let fontFetches: string[]
let guest: FakeGuest
const dir = useTempDir('design')
afterEach(stopRuntimes)

const FAKE_PDF = Buffer.from('%PDF-1.4 fake')

const render: DesignRenderBackend = {
  render: async (request) => {
    renders.push(request)
    const height = request.height ?? 700
    return {
      height,
      problems: request.url.includes('overflow')
        ? [{ kind: 'text_overflow', message: 'h1 "Long" cuts off its content (40px wider than the box).' }]
        : [],
      outline: ['- h1 @n1 "Hello" (24,24 300×40)'],
      png: request.screenshot
        ? solidPng(
            Math.round(request.width * request.scale),
            Math.round(height * request.scale),
            [10, 170, 120],
          )
        : null,
    }
  },
  pdf: async () => new Uint8Array(FAKE_PDF),
  available: () => true,
  close: async () => undefined,
}

/** Google Fonts stand-in: a css2 stylesheet with a latin face and its font file. */
const fontFetch = async (url: string): Promise<Response> => {
  fontFetches.push(url)
  if (url.startsWith('https://fonts.googleapis.com/css2?family=Fraunces'))
    return new Response(
      `/* latin */\n@font-face { font-family: 'Fraunces'; font-style: normal; font-weight: 100 900; src: url(https://fonts.gstatic.com/fraunces.woff2) format('woff2'); unicode-range: U+0000-00FF; }`,
    )
  if (url === 'https://fonts.gstatic.com/fraunces.woff2') return new Response(Buffer.from('wOF2fake-font'))
  return new Response('nope', { status: 400 })
}

async function boot(turn: (request: CompletionRequest, i: number) => FakeStep = () => ({ text: 'ok' })) {
  requests = []
  renders = []
  fontFetches = []
  let turns = 0
  h = await bootRuntime({
    // The design fonts live in <dataRoot>/fonts, next to the workspaces folder.
    dir: join(dir(), 'workspaces', TEST_WORKSPACE_ID),
    script: (request) => {
      requests.push(request)
      if (JSON.stringify(request.messages[0]).includes(DRAW_PROMPT_MARKER)) return drawing
      if (request.tools.length === 0) return { text: 'Hello!' }
      return turn(request, turns++)
    },
    overrides: {
      design: { render: () => render, fontFetch, imageFetch: async () => new Response('x', { status: 404 }) },
    },
  })
  ;({ runtime, host, events, guest, botId, dm } = h)
  await host.idle()
}

const call: RuntimeHarness['call'] = (...args) => h.call(...args)

/** Every string in a tool call's stored result. */
function toolText(row: ToolCallRow | undefined): string {
  const out: string[] = []
  const walk = (value: unknown) => {
    if (typeof value === 'string') out.push(value)
    else if (Array.isArray(value)) value.forEach(walk)
    else if (value && typeof value === 'object') Object.values(value).forEach(walk)
  }
  walk(row?.result)
  return out.join('\n')
}

describe('designs', () => {
  it('a bot loads the design skill, draws, checks and exports; the chat card follows the design', async () => {
    // The accent in 'Café' checks that export file names are folded ('01-cafe').
    await boot(
      (_request, i) =>
        [
          { toolCalls: [{ name: 'skill_load', arguments: { name: 'design' } }] },
          {
            toolCalls: [
              {
                name: 'design_create',
                arguments: {
                  name: 'Café app',
                  themes: ['Light', 'Dark'],
                  tokens: [
                    { name: 'primary', values: { Light: '#0a7', Dark: '#3c9' } },
                    { name: 'radius-card', value: 16 },
                  ],
                },
              },
            ],
          },
          {
            toolCalls: [
              {
                name: 'design_write_frame',
                arguments: {
                  design: 'Café app',
                  name: 'Café',
                  width: 390,
                  height: 844,
                  html: '<main class="p-6"><h1 class="text-2xl text-primary">Hello</h1><i data-icon="lucide:check"></i></main>',
                },
              },
            ],
          },
          {
            toolCalls: [
              {
                name: 'design_write_frame',
                arguments: {
                  design: 'Café app',
                  name: 'Menu',
                  width: 390,
                  html: '<ul><li>Item</li></ul>',
                },
              },
            ],
          },
          {
            toolCalls: [{ name: 'design_screenshot', arguments: { design: 'Café app', frames: ['Café'] } }],
          },
          {
            toolCalls: [
              {
                name: 'design_export',
                arguments: { design: 'Café app', format: 'pdf', path: '/workspace/out/cafe.pdf' },
              },
            ],
          },
          {
            toolCalls: [
              {
                name: 'design_export',
                arguments: {
                  design: 'Café app',
                  frames: ['Café'],
                  format: 'html',
                  path: '/workspace/out/html',
                },
              },
            ],
          },
          { text: 'Done: I drew the app.' },
        ][i] ?? { text: 'ok' },
    )
    await call('postMessage', { conversationId: dm }, { content: 'draw an app for a café' })
    await host.idle()
    await runtime.services.designs.idle()

    expect(requests[0]?.tools.map((t) => t.name)).toEqual(
      expect.arrayContaining(['design_create', 'design_write_frame', 'design_export']),
    )
    const tools = await call<ToolCallRow[]>('listToolCalls', { conversationId: dm }, undefined, { limit: 20 })
    const [load, create, write, second, shot, pdf, html] = tools
    expect(tools.every((t) => t.status === 'ok')).toBe(true)
    expect(toolText(load)).toContain('# Designing on the canvas')
    expect(toolText(create)).toMatch(/Created the design "Café app" \(dsg_\w+\)/)
    expect(toolText(write)).toMatch(/Added the frame "Café" \(dfr_\w+\) 390×844 at \(0, 0\)/)
    expect(toolText(write)).toContain('- h1 @n1 "Hello"')
    expect(toolText(second)).toMatch(/390×auto \(700\) at \(470, 0\)/)
    expect(toolText(shot)).toContain('"Café" 390×844 · theme Light')
    expect(toolText(pdf)).toContain('/workspace/out/cafe.pdf')
    expect(toolText(html)).toContain('/workspace/out/html/tokens.css')
    expect(tools.map((t) => t.kind)).toEqual([
      'skill_load',
      'design_create',
      'design_write_frame',
      'design_write_frame',
      'design_screenshot',
      'design_export',
      'design_export',
    ])

    expect(Buffer.from(String(guest.state.files.get('/workspace/out/cafe.pdf')), 'base64')).toEqual(FAKE_PDF)
    const tokensCss = Buffer.from(String(guest.state.files.get('/workspace/out/html/tokens.css')), 'base64')
    expect(tokensCss.toString()).toContain('[data-theme="Dark"] {\n  --color-primary: #3c9;')
    const source = Buffer.from(
      String(guest.state.files.get('/workspace/out/html/01-cafe.source.html')),
      'base64',
    )
    expect(source.toString()).toContain('<h1 class="text-2xl text-primary">Hello</h1>')
    const standalone = Buffer.from(
      String(guest.state.files.get('/workspace/out/html/01-cafe.html')),
      'base64',
    )
    expect(standalone.toString()).toMatch(/^<!doctype html>[\s\S]*<svg[^>]*data-icon="lucide:check"/)

    const [design] = await call<Design[]>('listDesigns', {}, undefined, { conversationId: dm })
    expect(design).toMatchObject({
      name: 'Café app',
      botId,
      frameCount: 2,
      themes: ['Light', 'Dark'],
    })
    expect(design?.thumbnailSha).toMatch(/^[0-9a-f]{64}$/)
    // design_screenshot and the thumbnail of the first frame (a frame narrower than 480px keeps scale 1).
    expect(
      renders.filter((r) => r.screenshot && r.width === 390 && r.height === 844).length,
    ).toBeGreaterThanOrEqual(2)
    expect(renders.every((r) => r.url.startsWith('http://10.0.2.2:'))).toBe(true)

    const messages = (
      await call<{ messages: Message[] }>('listMessages', { conversationId: dm }, undefined, {})
    ).messages
    const cards = messages.filter((m) => (m.payload as { type?: string } | null)?.type === 'design')
    expect(cards).toHaveLength(1)
    expect(cards[0]?.payload).toMatchObject({
      type: 'design',
      designId: design?.id,
      name: 'Café app',
      frameCount: 2,
      thumbnailSha: design?.thumbnailSha,
    } satisfies Partial<DesignPayload>)
    expect(events.some((e) => e.type === 'design.presence' && e.payload.botId === botId)).toBe(true)
    expect(events.some((e) => e.type === 'design.frame.updated')).toBe(true)

    // The runtime's HTTP server serves the compiled frame to the renderer's Chrome, only with the token.
    const url = renders[0]?.url.replace('10.0.2.2', '127.0.0.1') as string
    const page = await fetch(url)
    expect(page.headers.get('content-type')).toContain('text/html')
    expect(await page.text()).toContain('--color-primary: #0a7;')
    expect((await fetch(url.replace(/render\/[0-9a-f]+/, `render/${'0'.repeat(48)}`))).status).toBe(404)
  })

  it('serves frames to the app, pushes dropped frames clear and keeps revisions the bot and user can restore', async () => {
    await boot(
      (_request, i) =>
        [
          {
            toolCalls: [
              {
                name: 'design_create',
                arguments: {
                  name: 'Site',
                  themes: ['Green', 'Night'],
                  tokens: [{ name: 'primary', values: { Green: '#0a7', Night: '#123' } }],
                },
              },
            ],
          },
          {
            toolCalls: [
              {
                name: 'design_write_frame',
                arguments: { design: 'Site', name: 'Home', width: 1440, height: 900, html: '<h1>Home</h1>' },
              },
            ],
          },
          {
            toolCalls: [
              {
                name: 'design_write_frame',
                arguments: {
                  design: 'Site',
                  name: 'About',
                  width: 1440,
                  height: 900,
                  html: '<h1>About</h1>',
                },
              },
            ],
          },
          { text: 'done' },
          { toolCalls: [{ name: 'design_read', arguments: { design: 'Site' } }] },
          { text: 'seen' },
        ][i] ?? { text: 'ok' },
    )
    await call('postMessage', { conversationId: dm }, { content: 'make a site' })
    await host.idle()
    const [summary] = await call<Design[]>('listDesigns')
    const detail = await call<DesignDetail>('getDesign', { designId: summary?.id as string })
    const [home, about] = detail.frames
    expect(detail.frames.map((f) => [f.name, f.x, f.y])).toEqual([
      ['Home', 0, 0],
      ['About', 1520, 0],
    ])

    const doc = await call<DesignFrameHtml>(
      'getDesignFrameHtml',
      { designId: detail.id, frameId: home?.id as string },
      undefined,
      { theme: 'night' },
    )
    expect(doc).toMatchObject({ theme: 'Night', width: 1440, height: 900, problems: [] })
    expect(doc.html).toContain('--color-primary: #123;')

    const moved = await call<DesignFrame>(
      'moveDesignFrame',
      { designId: detail.id, frameId: about?.id as string },
      { x: 200, y: 100 },
    )
    expect(moved.x === 200 && moved.y === 100).toBe(false)
    expect(moved.x >= 1440 + 40 || moved.y >= 900 + 40).toBe(true)

    const edited = await call<Design>(
      'updateDesignTokens',
      { designId: detail.id },
      { values: { 'color-primary': { Night: '#456' } } },
    )
    expect(edited.tokens[0]?.values).toEqual({ Green: '#0a7', Night: '#456' })
    await expect(
      call('updateDesignTokens', { designId: detail.id }, { values: { 'color-nope': { Night: '#000' } } }),
    ).rejects.toMatchObject({ code: 'validation_failed' })

    await call('postMessage', { conversationId: dm }, { content: 'did you see what I changed?' })
    await host.idle()
    const tools = await call<ToolCallRow[]>('listToolCalls', { conversationId: dm }, undefined, { limit: 20 })
    expect(toolText(tools.find((t) => t.toolName === 'design_read'))).toContain(
      'Changed by the user since the last bot change: tokens: color-primary',
    )

    const revisions = await call<DesignRevision[]>('listDesignRevisions', { designId: detail.id })
    expect(revisions.map((r) => [r.authorType, r.summary])).toEqual([
      ['user', 'tokens: color-primary'],
      ['bot', 'frame About added'],
      ['bot', 'frame Home added'],
    ])
    const restored = await call<DesignDetail>('restoreDesignRevision', {
      designId: detail.id,
      revisionId: revisions[1]?.id as string,
    })
    expect(restored.frames.find((f) => f.name === 'About')).toMatchObject({ x: 1520, y: 0 })
    expect((await call<DesignRevision[]>('listDesignRevisions', { designId: detail.id }))[0]).toMatchObject({
      authorType: 'user',
      summary: 'frame About restored',
    })

    const undone = await call<DesignDetail>(
      'restoreDesignRevision',
      { designId: detail.id, revisionId: revisions[0]?.id as string },
      { undo: true },
    )
    expect(undone.tokens[0]?.values).toEqual({ Green: '#0a7', Night: '#123' })
    await expect(
      call(
        'restoreDesignRevision',
        { designId: detail.id, revisionId: revisions[2]?.id as string },
        { undo: true },
      ),
    ).rejects.toMatchObject({ code: 'conflict' })

    const source = await call<DesignFrameSource>('getDesignFrameSource', {
      designId: detail.id,
      frameId: home?.id as string,
    })
    expect(source).toMatchObject({ name: 'Home', theme: 'Green' })
    expect(source.source).toContain('<h1>Home</h1>')
    expect(source.tokensCss).toContain('--color-primary')
    expect(source.html).toContain('<!doctype html>')

    const renamed = await call<Design>('renameDesign', { designId: detail.id }, { name: 'Site v2' })
    expect(renamed.name).toBe('Site v2')
    const card = (
      await call<{ messages: Message[] }>('listMessages', { conversationId: dm }, undefined, {})
    ).messages.find((m) => (m.payload as { type?: string } | null)?.type === 'design')
    expect(card?.payload).toMatchObject({ name: 'Site v2' })

    await call('deleteDesign', { designId: detail.id })
    expect(await call<Design[]>('listDesigns')).toEqual([])
    expect(events.some((e) => e.type === 'design.deleted' && e.payload.designId === detail.id)).toBe(true)
    const messages = (
      await call<{ messages: Message[] }>('listMessages', { conversationId: dm }, undefined, {})
    ).messages
    expect(
      messages.find((m) => (m.payload as { type?: string } | null)?.type === 'design')?.payload,
    ).toMatchObject({
      removed: true,
    })
  })

  it('embeds Google Fonts downloaded once into the fonts folder', async () => {
    await boot(
      (_request, i) =>
        [
          {
            toolCalls: [
              {
                name: 'design_create',
                arguments: {
                  name: 'Brand',
                  fonts: ['Fraunces'],
                  tokens: [{ name: 'display', type: 'font', value: 'Fraunces' }],
                },
              },
            ],
          },
          {
            toolCalls: [
              {
                name: 'design_write_frame',
                arguments: {
                  design: 'Brand',
                  name: 'Cover',
                  width: 800,
                  height: 600,
                  html: '<h1 class="font-display">Brand</h1>',
                },
              },
            ],
          },
          { text: 'ok' },
        ][i] ?? { text: 'ok' },
    )
    await call('postMessage', { conversationId: dm }, { content: 'create the brand' })
    await host.idle()
    await runtime.services.designs.idle()
    const [design] = await call<Design[]>('listDesigns')
    const [frame] = (await call<DesignDetail>('getDesign', { designId: design?.id as string })).frames
    const doc = await call<DesignFrameHtml>('getDesignFrameHtml', {
      designId: design?.id as string,
      frameId: frame?.id as string,
    })
    expect(doc.problems).toEqual([])
    expect(doc.html).toContain('font-family: "Fraunces";')
    expect(doc.html).toContain(
      `url(data:font/woff2;base64,${Buffer.from('wOF2fake-font').toString('base64')})`,
    )
    expect(doc.html).toContain('--font-display: "Fraunces", ui-sans-serif, system-ui, sans-serif;')
    expect(fontFetches).toEqual([
      'https://fonts.googleapis.com/css2?family=Fraunces:wght@100..900&display=swap',
      'https://fonts.gstatic.com/fraunces.woff2',
    ])
  })

  it('exports a design to a .mbdesign that another workspace imports as a new design', async () => {
    const png = solidPng(8, 8, [200, 30, 30])
    const image = `data:image/png;base64,${Buffer.from(png).toString('base64')}`
    await boot(
      (_request, i) =>
        [
          {
            toolCalls: [
              {
                name: 'design_create',
                arguments: {
                  name: 'Shop',
                  themes: ['Light', 'Dark'],
                  fonts: ['Fraunces'],
                  tokens: [{ name: 'primary', values: { Light: '#0a7', Dark: '#123' } }],
                },
              },
            ],
          },
          {
            toolCalls: [
              {
                name: 'design_write_frame',
                arguments: {
                  design: 'Shop',
                  name: 'Home',
                  width: 800,
                  height: 600,
                  html: `<img src="${image}"><h1 class="text-primary">Home</h1>`,
                },
              },
            ],
          },
          {
            toolCalls: [
              {
                name: 'design_write_frame',
                arguments: {
                  design: 'Shop',
                  name: 'Cart',
                  width: 400,
                  theme: 'Dark',
                  html: '<h1>Cart</h1>',
                  css: 'h1 { letter-spacing: 1px; }',
                },
              },
            ],
          },
          { text: 'done' },
        ][i] ?? { text: 'ok' },
    )
    await call('postMessage', { conversationId: dm }, { content: 'make a shop' })
    await host.idle()
    const [source] = await call<Design[]>('listDesigns')
    const original = await call<DesignDetail>('getDesign', { designId: source?.id as string })
    const path = join(dir(), 'shop.mbdesign')
    await call('exportDesign', { designId: original.id }, { path })
    expect(existsSync(path)).toBe(true)
    expect(existsSync(`${path}.partial`)).toBe(false)
    const onePath = join(dir(), 'cart.mbdesign')
    await call(
      'exportDesign',
      { designId: original.id },
      { path: onePath, frameIds: [original.frames[1]?.id] },
    )
    await expect(
      call('exportDesign', { designId: original.id }, { path: join(dir(), 'x.zip') }),
    ).rejects.toThrow()

    const other = await bootRuntime({
      dir: join(dir(), 'workspaces', 'ws_other'),
      workspaceId: 'ws_other',
      vm: false,
      script: () => ({ text: 'ok' }),
      overrides: { design: { render: () => render, fontFetch } },
    })
    const imported = await other.call<Design>('importDesign', undefined, { path, conversationId: other.dm })
    expect(imported).toMatchObject({
      name: 'Shop',
      conversationId: other.dm,
      botId: null,
      themes: ['Light', 'Dark'],
      fonts: ['Fraunces'],
      tokens: source?.tokens,
      frameCount: 2,
    })
    const detail = await other.call<DesignDetail>('getDesign', { designId: imported.id })
    expect(detail.frames.map((f) => [f.name, f.x, f.y, f.width, f.height, f.theme])).toEqual(
      original.frames.map((f) => [f.name, f.x, f.y, f.width, f.height, f.theme]),
    )
    const home = await other.call<DesignFrameSource>('getDesignFrameSource', {
      designId: imported.id,
      frameId: detail.frames[0]?.id as string,
    })
    expect(home.html).toContain(`data:image/png;base64,${Buffer.from(png).toString('base64')}`)
    const cart = await other.call<DesignFrameSource>('getDesignFrameSource', {
      designId: imported.id,
      frameId: detail.frames[1]?.id as string,
    })
    expect(cart.source).toContain('letter-spacing: 1px')
    const messages = other.messages(other.dm)
    const card = messages.find((m) => (m.payload as { type?: string } | null)?.type === 'design')
    expect(card).toMatchObject({ authorType: 'system', payload: { designId: imported.id, name: 'Shop' } })

    const again = await other.call<Design>('importDesign', undefined, { path, conversationId: other.dm })
    expect(again.name).toBe('Shop (2)')
    const single = await other.call<Design>('importDesign', undefined, {
      path: onePath,
      conversationId: other.dm,
    })
    expect(single).toMatchObject({ name: 'Shop (3)', frameCount: 1 })

    const reason = (p: Promise<unknown>) =>
      p.then(
        () => null,
        (err: { details?: { reason?: string } }) => err.details?.reason,
      )
    const importFrom = (file: string) =>
      other.call('importDesign', undefined, { path: file, conversationId: other.dm })
    const garbage = join(dir(), 'garbage.mbdesign')
    await writeFile(garbage, 'not a zip')
    expect(await reason(importFrom(garbage))).toBe('design_file_invalid')
    expect(await reason(importFrom(join(dir(), 'missing.mbdesign')))).toBe('file_missing')

    const craft = async (name: string, entries: Record<string, string | Buffer>) => {
      const file = join(dir(), name)
      const zip = await ZipWriter.create(file)
      for (const [entry, data] of Object.entries(entries)) await zip.addBuffer(entry, data)
      await zip.finish()
      return file
    }
    const manifest = (version: number) =>
      JSON.stringify({ format: 'milibot-design', formatVersion: version, exportedAt: 1 })
    const design = JSON.stringify({
      name: 'X',
      themes: ['Default'],
      tokens: [],
      fonts: [],
      frames: [{ file: '1-a', name: 'A', x: 0, y: 0, width: 100, height: 100, theme: null }],
    })
    const fakeSha = 'a'.repeat(64)
    expect(
      await reason(
        importFrom(await craft('new.mbdesign', { 'manifest.json': manifest(99), 'design.json': design })),
      ),
    ).toBe('design_file_too_new')
    expect(
      await reason(
        importFrom(
          await craft('bad-sha.mbdesign', {
            'manifest.json': manifest(1),
            'design.json': design,
            'frames/1-a.html': `<img src="asset:${fakeSha}">`,
            [`assets/${fakeSha}`]: Buffer.from(png),
          }),
        ),
      ),
    ).toBe('design_file_invalid')
    expect(
      await reason(
        importFrom(
          await craft('bad-token.mbdesign', {
            'manifest.json': manifest(1),
            'design.json': JSON.stringify({
              ...JSON.parse(design),
              tokens: [{ name: 'color-x', type: 'color', value: 'red; } body { x: y', values: {} }],
            }),
            'frames/1-a.html': '<p>a</p>',
          }),
        ),
      ),
    ).toBe('design_file_invalid')
    expect(await other.call<Design[]>('listDesigns')).toHaveLength(3)
  })

  it('a bot starts a drawing, keeps designing, and the frame placing it gets the drawing when it lands', async () => {
    drawing = {
      pieceDelayMs: 40,
      text: '```svg\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><circle fill="#0a7" cx="32" cy="32" r="24"/><path fill="none" stroke="#fff" stroke-width="4" d="M18 32 C 24 20 40 20 46 32 S 40 44 32 44"/></svg>\n```',
    }
    await boot(
      (_request, i) =>
        [
          { toolCalls: [{ name: 'skill_load', arguments: { name: 'design' } }] },
          { toolCalls: [{ name: 'design_create', arguments: { name: 'Brand', themes: ['Light'] } }] },
          {
            toolCalls: [
              {
                name: 'design_draw',
                arguments: {
                  design: 'Brand',
                  name: 'Logo',
                  prompt: 'A round green mark with a white swirl, flat, #00aa77 and #ffffff',
                  width: 128,
                  height: 128,
                },
              },
            ],
          },
          {
            toolCalls: [
              {
                name: 'design_write_frame',
                arguments: {
                  design: 'Brand',
                  name: 'Header',
                  width: 800,
                  height: 96,
                  html: '<header class="p-6"><img data-art="Logo" class="h-12 w-auto" alt="Brand"></header>',
                },
              },
            ],
          },
          { text: 'Started the logo; the header already places it.' },
        ][i] ?? { text: 'ok' },
    )
    await call('postMessage', { conversationId: dm }, { content: 'make a logo and a header' })
    await host.idle()
    await runtime.services.designs.idle()

    const tools = await call<ToolCallRow[]>('listToolCalls', { conversationId: dm }, undefined, { limit: 20 })
    const [, , draw, header] = tools
    expect(toolText(draw)).toMatch(/Started drawing "Logo" \(dfr_\w+\) 128×128/)
    expect(toolText(header)).toMatch(/"Logo" is still being drawn|No layout problems found/)

    const [design] = await call<Design[]>('listDesigns', {})
    const detail = await call<DesignDetail>('getDesign', { designId: design?.id as string })
    const logo = detail.frames.find((f) => f.name === 'Logo')
    const headerFrame = detail.frames.find((f) => f.name === 'Header')
    expect(logo?.art).toEqual({ status: 'ready', botId })
    const drafts = events.flatMap((e) =>
      e.type === 'design.frame.draft' && e.payload.art ? [e.payload] : [],
    )
    expect(drafts.length).toBeGreaterThan(1)
    expect(drafts.every((d) => d.frameId === logo?.id && d.art?.pen)).toBe(true)
    expect(
      events.some((e) => e.type === 'design.frame.draft.cleared' && e.payload.draftId === `art:${logo?.id}`),
    ).toBe(true)
    const page = await call<{ html: string; problems: unknown[] }>('getDesignFrameHtml', {
      designId: detail.id,
      frameId: headerFrame?.id as string,
    })
    expect(page.html).toContain('src="data:image/svg+xml;base64,')
    expect(page.problems).toEqual([])
    const logged = h.store.db
      .prepare("SELECT purpose, turn_id AS turnId FROM llm_calls WHERE purpose = 'design_draw'")
      .all() as Array<{ purpose: string; turnId: string | null }>
    expect(logged).toEqual([{ purpose: 'design_draw', turnId: draw?.turnId }])
  })
})
