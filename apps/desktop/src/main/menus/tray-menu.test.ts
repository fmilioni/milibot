import type { WorkspaceSummary } from '@milibot/shared'
import { describe, expect, it } from 'vitest'

import { trayMenuTemplate } from './tray-menu'

// Portuguese on purpose: asserts the pt-BR tray labels.

const workspace = (id: string, name: string, lastOpenedAt: number, running: boolean) =>
  ({
    id,
    name,
    createdAt: 1,
    lastOpenedAt,
    runtimeStatus: running ? 'running' : 'stopped',
  }) as WorkspaceSummary

describe('trayMenuTemplate', () => {
  it('lists the workspaces (most recent first), the status and quit', () => {
    const opened: string[] = []
    let quit = false
    const menu = trayMenuTemplate(
      'pt-BR',
      'Milibot',
      {
        workspaces: [workspace('a', 'Personal', 10, true), workspace('b', 'Client', 20, false)],
        starting: false,
      },
      { openWorkspace: (id) => opened.push(id), showLogs: () => undefined, quit: () => (quit = true) },
    )
    expect(menu.map((item) => item.label ?? '-')).toEqual([
      'Abrir workspace',
      '-',
      'Serviço ativo · workspaces rodando: 1',
      'Mostrar registros',
      '-',
      'Sair do Milibot',
    ])
    const submenu = menu[0]?.submenu as { label: string; click: () => void }[]
    expect(submenu.map((item) => item.label)).toEqual(['Client', 'Personal'])
    submenu[1]?.click()
    expect(opened).toEqual(['a'])
    expect(menu[2]?.enabled).toBe(false)
    ;(menu[5]?.click as () => void)()
    expect(quit).toBe(true)
  })

  it('shows the service stopped or starting when the daemon does not answer', () => {
    const actions = { openWorkspace: () => undefined, showLogs: () => undefined, quit: () => undefined }
    const stopped = trayMenuTemplate('en', 'Milibot', { workspaces: null, starting: false }, actions)
    expect(stopped[2]?.label).toBe('Background service stopped')
    expect((stopped[0]?.submenu as { enabled?: boolean }[])[0]?.enabled).toBe(false)
    const starting = trayMenuTemplate('en', 'Milibot', { workspaces: null, starting: true }, actions)
    expect(starting[2]?.label).toBe('Starting the service…')
  })
})
