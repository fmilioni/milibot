import { join } from 'node:path'

import type { ToolExecContext, ToolResult } from '@milibot/agent'
import { makeBot } from '@milibot/agent/testing'
import type { Message, WorkspaceEvent } from '@milibot/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { FileBlobStore } from '../../../src/runtime/blobs'
import { defaultDesignAssets } from '../../../src/runtime/design/assets'
import { ChromeDesignRenderer } from '../../../src/runtime/design/render'
import { DesignService } from '../../../src/runtime/design/service'
import { DesignTools } from '../../../src/runtime/design/tools'
import { McpToolServer } from '../../../src/runtime/mcp-server/server'
import type { VmController } from '../../../src/runtime/vm/controller'
import { openWorkspaceDb } from '../../../src/workspace-db/open'
import { findChrome, type LocalChrome, startLocalChrome } from '../../support/local-chrome'
import { removeDir, tempDir } from '../../support/temp'

/** Layout checks, screenshots and PDFs of design frames in a real (headless, local) Chrome. */
const chromePath = findChrome()

function pngSize(bytes: Uint8Array): { width: number; height: number } {
  const b = Buffer.from(bytes)
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) }
}

describe.skipIf(!chromePath)('design rendering in Chrome', () => {
  let chrome: LocalChrome
  let dir: string
  let server: McpToolServer
  let designs: DesignService
  let tools: DesignTools
  const written = new Map<string, Buffer>()
  const events: WorkspaceEvent[] = []
  const ctx: ToolExecContext = {
    bot: makeBot({ slug: 'lia', name: 'Lia' }),
    conversationId: 'cnv_1',
    turnId: 'trn_1',
    signal: new AbortController().signal,
  }
  const call = async (name: string, args: Record<string, unknown>): Promise<ToolResult> =>
    tools.execute(ctx, { id: name, name, arguments: args })
  const textOf = (result: ToolResult) =>
    result.content.map((p) => (p.type === 'text' ? p.text : `[image ${p.width}x${p.height}]`)).join('\n')

  beforeAll(async () => {
    chrome = await startLocalChrome(chromePath as string)
    dir = tempDir('design-render')
    const db = openWorkspaceDb(':memory:')
    const guest = {
      fsWriteAll: async (path: string, data: Uint8Array | string) => {
        written.set(path, Buffer.from(data))
      },
    }
    const vm = {
      guest: async () => guest,
      runningGuest: () => guest,
      status: () => ({ state: 'running' }),
      subscribe: () => () => {},
    } as unknown as VmController
    const blobs = new FileBlobStore(join(dir, 'blobs'))
    let messages = 0
    const message = (payload: unknown) => ({ id: `msg_${++messages}`, payload }) as unknown as Message
    designs = new DesignService({
      db,
      vm,
      blobs,
      render: new ChromeDesignRenderer({ vm, channel: () => chrome.channel() }),
      renderBase: () => server.baseUrl('127.0.0.1'),
      assets: defaultDesignAssets(),
      fontsDir: null,
      assertConversation: () => undefined,
      appendMessage: (m) => message(m.payload),
      updateMessage: (id, patch) => ({ id, payload: patch.payload }) as unknown as Message,
      emit: (event) => events.push(event),
      now: Date.now,
    })
    tools = new DesignTools({
      designs,
      getBot: () => ctx.bot,
      cardConversation: (_bot, conversationId) => conversationId ?? 'cnv_1',
    })
    server = new McpToolServer({
      getBot: () => null,
      runTool: async () => ({ content: [] }),
      render: (token, path, query) => designs.renderDocument(token, path, query),
      blobs,
      version: 'test',
    })
  }, 30_000)

  afterAll(async () => {
    await designs?.close()
    await server?.close()
    await chrome?.close()
    if (dir) removeDir(dir)
  })

  it('reports text that does not fit and elements past the frame, and screenshots at the frame size', async () => {
    await call('design_create', {
      name: 'Landing',
      themes: ['Light', 'Night'],
      tokens: [{ name: 'primary', values: { Light: '#0a7', Night: '#3c9' } }],
    })
    const written = textOf(
      await call('design_write_frame', {
        design: 'Landing',
        name: 'Hero',
        width: 400,
        height: 300,
        html:
          '<div data-id="title" class="w-[120px] h-[40px] overflow-hidden whitespace-nowrap bg-primary">A very long headline that cannot fit</div>' +
          '<div class="absolute left-[350px] top-10 w-[200px] h-10 bg-primary"></div>' +
          '<p class="mt-4">All good here</p>',
      }),
    )
    expect(written).toMatch(/div#title "A very long headline that cannot fit" .* cuts off its content/)
    expect(written).toMatch(/goes past the frame \(400×300\)/)
    expect(written).toMatch(/Outline/)
    expect(written).toMatch(/- p @n\d+ "All good here"/)

    const shot = await call('design_screenshot', { design: 'Landing', frames: ['Hero'] })
    const image = shot.content.find((p) => p.type === 'image')
    expect(image).toMatchObject({ type: 'image', width: 400, height: 300 })
    const bytes = await new FileBlobStore(join(dir, 'blobs')).read((image as { sha256: string }).sha256)
    expect(pngSize(bytes)).toEqual({ width: 400, height: 300 })

    const double = await call('design_screenshot', {
      design: 'Landing',
      frames: ['Hero'],
      scale: 2,
      theme: 'Night',
    })
    const big = double.content.find((p) => p.type === 'image') as { sha256: string }
    expect(pngSize(await new FileBlobStore(join(dir, 'blobs')).read(big.sha256))).toEqual({
      width: 800,
      height: 600,
    })
  }, 60_000)

  it('measures frames that grow with their content and exports one PDF page per frame', async () => {
    const result = textOf(
      await call('design_write_frame', {
        design: 'Landing',
        name: 'Article',
        width: 390,
        html: '<article class="p-6 space-y-4"><h1 class="text-3xl font-bold">Title</h1><div class="h-[500px] bg-primary"></div></article>',
      }),
    )
    expect(result).toMatch(/Content height: 600px/)
    expect(result).toMatch(/No layout problems found/)

    const exported = textOf(
      await call('design_export', { design: 'Landing', format: 'pdf', path: '/workspace/out/landing.pdf' }),
    )
    expect(exported).toContain('/workspace/out/landing.pdf')
    const pdf = written.get('/workspace/out/landing.pdf') as Buffer
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-')
    const pages = [...pdf.toString('latin1').matchAll(/\/Type\s*\/Page[^s]/g)].length
    expect(pages).toBe(2)
    // Each page has its frame's size: 400×300 and 390×600 CSS px = 300×225 and 292.5×450 pt (rounded by Chrome).
    expect(pdf.toString('latin1')).toMatch(/\/MediaBox \[0 0 300 22[45][.\d]*\]/)
    expect(pdf.toString('latin1')).toMatch(/\/MediaBox \[0 0 29[23][.\d]* 450\]/)
  }, 60_000)
})
