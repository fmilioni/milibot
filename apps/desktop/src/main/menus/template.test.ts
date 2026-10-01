import type { MenuItemConstructorOptions } from 'electron'
import { describe, expect, it } from 'vitest'

import { mainText } from '../app/i18n'
import { appMenuTemplate, menuTemplate, windowMenuTemplate } from './template'

// Portuguese on purpose: asserts the pt-BR menu labels.

const actions = { stopService: () => undefined, showLogs: () => undefined }

function flatten(items: MenuItemConstructorOptions[]): MenuItemConstructorOptions[] {
  return items.flatMap((item) => [
    item,
    ...(Array.isArray(item.submenu) ? flatten(item.submenu as MenuItemConstructorOptions[]) : []),
  ])
}

const byRole = (items: MenuItemConstructorOptions[], role: string) =>
  flatten(items).find((item) => item.role === role)?.label

describe('appMenuTemplate', () => {
  it('labels the standard menus in Portuguese and keeps their roles', () => {
    const menu = appMenuTemplate('pt-BR', 'Milibot', actions)
    expect(menu.map((item) => item.label)).toEqual([
      'Milibot',
      'Arquivo',
      'Editar',
      'Visualizar',
      'Janela',
      'Ajuda',
    ])
    expect(byRole(menu, 'about')).toBe('Sobre o Milibot')
    expect(byRole(menu, 'quit')).toBe('Encerrar Milibot')
    expect(byRole(menu, 'copy')).toBe('Copiar')
    expect(byRole(menu, 'paste')).toBe('Colar')
    expect(byRole(menu, 'selectAll')).toBe('Selecionar Tudo')
    expect(byRole(menu, 'togglefullscreen')).toBe('Alternar Tela Cheia')
    expect(byRole(menu, 'minimize')).toBe('Minimizar')
    expect(menu[4]?.role).toBe('window')
    expect(menu[5]?.role).toBe('help')
  })

  it('labels the menus in English', () => {
    const menu = appMenuTemplate('en', 'Milibot', actions)
    expect(menu.map((item) => item.label)).toEqual(['Milibot', 'File', 'Edit', 'View', 'Window', 'Help'])
    expect(byRole(menu, 'hide')).toBe('Hide Milibot')
    expect(byRole(menu, 'undo')).toBe('Undo')
    expect(byRole(menu, 'front')).toBe('Bring All to Front')
  })

  it('gives every item a label and leaves out "stop service" for an external daemon', () => {
    for (const language of ['pt-BR', 'en'] as const) {
      const items = flatten(appMenuTemplate(language, 'Milibot', actions)).filter(
        (i) => i.type !== 'separator',
      )
      for (const item of items) expect(item.label, JSON.stringify(item.role)).toMatch(/\S/)
    }
    const labels = (stop: boolean) =>
      flatten(
        appMenuTemplate('pt-BR', 'Milibot', { ...actions, stopService: stop ? () => undefined : undefined }),
      )
        .map((i) => i.label)
        .filter(Boolean)
    const stopLabel = mainText('pt-BR', 'stopServiceMenu')
    expect(labels(true)).toContain(stopLabel)
    expect(labels(false)).not.toContain(stopLabel)
  })
})

describe('windowMenuTemplate (Linux and Windows)', () => {
  it('has only File, Edit, View and Help, without macOS-only roles', () => {
    const menu = menuTemplate('linux', 'pt-BR', 'Milibot', actions)
    expect(menu.map((item) => item.label)).toEqual(['Arquivo', 'Editar', 'Exibir', 'Ajuda'])
    const roles = flatten(menu).map((item) => item.role)
    for (const role of ['services', 'hide', 'hideOthers', 'unhide', 'front', 'startSpeaking', 'zoom'])
      expect(roles).not.toContain(role)
    expect(byRole(menu, 'quit')).toBe('Sair')
    expect(byRole(menu, 'copy')).toBe('Copiar')
    expect(byRole(menu, 'about')).toBe('Sobre o Milibot')
    expect(menuTemplate('win32', 'en', 'Milibot', actions).map((item) => item.label)).toEqual([
      'File',
      'Edit',
      'View',
      'Help',
    ])
  })

  it('keeps the macOS menu bar on darwin', () => {
    expect(menuTemplate('darwin', 'en', 'Milibot', actions)).toEqual(
      appMenuTemplate('en', 'Milibot', actions),
    )
  })

  it('offers "stop service" only when the app manages the daemon', () => {
    const labels = (stop: boolean) =>
      flatten(
        windowMenuTemplate('en', 'Milibot', { ...actions, stopService: stop ? () => undefined : undefined }),
      )
        .map((i) => i.label)
        .filter(Boolean)
    expect(labels(true)).toContain('Stop Background Service…')
    expect(labels(false)).not.toContain('Stop Background Service…')
    for (const item of flatten(windowMenuTemplate('pt-BR', 'Milibot', actions)).filter(
      (i) => i.type !== 'separator',
    ))
      expect(item.label).toMatch(/\S/)
  })

  it('offers the developer tools only when asked (unpackaged builds)', () => {
    for (const platform of ['darwin', 'linux'] as const) {
      expect(byRole(menuTemplate(platform, 'en', 'Milibot', actions), 'toggleDevTools')).toBeUndefined()
      expect(
        byRole(menuTemplate(platform, 'en', 'Milibot', { ...actions, devTools: true }), 'toggleDevTools'),
      ).toMatch(/\S/)
    }
  })
})
