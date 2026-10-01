import { pathToFileURL } from 'node:url'

import { describe, expect, it } from 'vitest'

import { isAppUrl, isTrustedSender, type RendererLocation } from './trust'

const packaged: RendererLocation = {
  indexFile: '/Applications/Milibot.app/Contents/Resources/app.asar/out/renderer/index.html',
}
const indexUrl = pathToFileURL(packaged.indexFile).href
const dev: RendererLocation = { devUrl: 'http://localhost:5173', indexFile: packaged.indexFile }

describe('isAppUrl', () => {
  it('accepts the packaged index file with any hash or query', () => {
    expect(isAppUrl(indexUrl, packaged)).toBe(true)
    expect(isAppUrl(`${indexUrl}#/vm?workspaceId=ws_1&botId=b1`, packaged)).toBe(true)
    expect(isAppUrl(`${indexUrl}?x=1`, packaged)).toBe(true)
  })

  it('refuses other files, hosts and schemes when packaged', () => {
    expect(isAppUrl('file:///tmp/milibot-design-export/page.html', packaged)).toBe(false)
    expect(isAppUrl(indexUrl.replace('index.html', 'other.html'), packaged)).toBe(false)
    expect(isAppUrl(indexUrl.replace('file:///', 'file://evil/'), packaged)).toBe(false)
    expect(isAppUrl('https://example.com/', packaged)).toBe(false)
    expect(isAppUrl('http://localhost:5173/', packaged)).toBe(false)
    expect(isAppUrl('about:blank', packaged)).toBe(false)
    expect(isAppUrl('not a url', packaged)).toBe(false)
  })

  it('accepts only the dev server origin in dev', () => {
    expect(isAppUrl('http://localhost:5173/', dev)).toBe(true)
    expect(isAppUrl('http://localhost:5173/#/canvas?designId=d1', dev)).toBe(true)
    expect(isAppUrl('http://localhost:5174/', dev)).toBe(false)
    expect(isAppUrl('https://localhost:5173/', dev)).toBe(false)
    expect(isAppUrl('http://localhost.evil.com:5173/', dev)).toBe(false)
    expect(isAppUrl(indexUrl, dev)).toBe(false)
  })
})

describe('isTrustedSender', () => {
  const known = (id: number) => id === 1

  it('trusts the top frame of an app window on the app page', () => {
    expect(isTrustedSender({ webContentsId: 1, frameUrl: indexUrl, topFrame: true }, packaged, known)).toBe(
      true,
    )
  })

  it('refuses subframes, unknown windows, gone frames and foreign pages', () => {
    const base = { webContentsId: 1, frameUrl: indexUrl, topFrame: true }
    expect(isTrustedSender({ ...base, topFrame: false }, packaged, known)).toBe(false)
    expect(isTrustedSender({ ...base, webContentsId: 2 }, packaged, known)).toBe(false)
    expect(isTrustedSender({ ...base, frameUrl: null }, packaged, known)).toBe(false)
    expect(isTrustedSender({ ...base, frameUrl: 'https://example.com/' }, packaged, known)).toBe(false)
  })
})
