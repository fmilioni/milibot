import { describe, expect, it } from 'vitest'

import { defaultDesignAssets } from '../../../src/runtime/design/assets'
import { DesignCompiler } from '../../../src/runtime/design/compile'
import { FontLibrary } from '../../../src/runtime/design/fonts'
import { applyTokenChanges } from '../../../src/runtime/design/tokens'

const THEMES = ['Light', 'Night']

describe('frame compiler', () => {
  const assets = defaultDesignAssets()
  const compiler = new DesignCompiler({
    assets,
    fonts: new FontLibrary({ dir: null, assets }),
    readAsset: async (sha) =>
      sha === 'a'.repeat(64)
        ? { bytes: Buffer.from('89504e470d0a1a0a', 'hex'), mediaType: 'image/png' }
        : null,
  })
  const design = {
    name: 'Store',
    themes: THEMES,
    tokens: applyTokenChanges(
      [],
      [
        { name: 'primary', values: { Light: '#0a7', Night: '#3c9' } },
        { name: 'radius-card', value: 14 },
      ],
      THEMES,
    ).tokens,
    fonts: [],
  }

  it('compiles Tailwind with the tokens of the frame theme into a self-contained document', async () => {
    const frame = {
      width: 400,
      height: 300,
      theme: 'night',
      html: `<div class="bg-primary rounded-card p-4 hover:bg-primary/50"><img src="asset:${'a'.repeat(64)}"><img src="asset:${'b'.repeat(64)}"></div>`,
      css: '.extra { @apply flex; }',
    }
    const out = await compiler.compile(design, frame)
    expect(out.theme).toBe('Night')
    expect(out.html).toMatch(/^<!doctype html>/)
    expect(out.html).toContain(`default-src 'none'`)
    expect(out.html).toContain('--color-primary: #3c9;')
    expect(out.html).toContain('--radius-card: 14px;')
    expect(out.html).toMatch(/\.bg-primary \{\n\s+background-color: var\(--color-primary\);/)
    expect(out.html).toMatch(/\.rounded-card \{\n\s+border-radius: var\(--radius-card\);/)
    expect(out.html).toMatch(/\.extra \{\n\s+display: flex;/)
    expect(out.html).toContain('font-family: "Inter";')
    expect(out.html).toContain('src="data:image/png;base64,iVBORw0KGgo="')
    expect(out.html).toContain('body{width:400px;height:300px;overflow:hidden;')
    expect(out.problems).toEqual([expect.objectContaining({ kind: 'asset_missing' })])
    expect((await compiler.compile(design, frame, 'Light')).html).toContain('--color-primary: #0a7;')
  })

  it('leaves out CSS Tailwind cannot compile and says so', async () => {
    const out = await compiler.compile(design, {
      width: 200,
      height: null,
      theme: null,
      html: '<p class="text-primary">x</p>',
      css: '.x { @apply not-a-utility; } @import url(https://evil/x.css);',
    })
    expect(out.problems).toEqual([expect.objectContaining({ kind: 'css_error' })])
    expect(out.html).not.toContain('evil')
    expect(out.html).toContain('body{width:200px;overflow-x:hidden;')
  })
})
