import { pathToFileURL } from 'node:url'

import { describe, expect, it } from 'vitest'

import { permissionAllowed } from './permissions'

const where = { indexFile: '/opt/Milibot/resources/app.asar/out/renderer/index.html' }
const app = `${pathToFileURL(where.indexFile).href}#/vm?botId=b1`

describe('permissionAllowed', () => {
  it('lets the app page write the clipboard and go full screen', () => {
    expect(permissionAllowed('clipboard-sanitized-write', app, where)).toBe(true)
    expect(permissionAllowed('fullscreen', app, where)).toBe(true)
  })

  it('denies everything else, and anything asked by another page', () => {
    for (const permission of [
      'clipboard-read',
      'media',
      'notifications',
      'geolocation',
      'pointerLock',
      'openExternal',
    ])
      expect(permissionAllowed(permission, app, where), permission).toBe(false)
    expect(permissionAllowed('fullscreen', 'https://example.com/', where)).toBe(false)
    expect(permissionAllowed('clipboard-sanitized-write', 'about:srcdoc', where)).toBe(false)
    expect(permissionAllowed('fullscreen', '', where)).toBe(false)
  })
})
