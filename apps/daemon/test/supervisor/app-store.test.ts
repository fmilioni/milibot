import { describe, expect, it } from 'vitest'

import { readDaemonConfig } from '../../src/config/env'
import { AppStore } from '../../src/supervisor/app-store'

describe('VM port ranges', () => {
  it('starts new ranges below the ephemeral ports, 100 ports apart, and keeps a range once given', () => {
    const store = AppStore.open(':memory:')
    for (const id of ['ws_a', 'ws_b', 'ws_c'])
      store.insertWorkspace({ id, name: id, color: 'blue', icon: null, dir: `/data/${id}` })
    store.db.prepare('UPDATE workspaces SET vm_port_base = 47000 WHERE id = ?').run('ws_a')
    expect(store.vmPortBase('ws_a')).toBe(47000)
    expect(store.vmPortBase('ws_b')).toBe(24000)
    expect(store.vmPortBase('ws_c')).toBe(24100)
    expect(store.vmPortBase('ws_b')).toBe(24000)
    store.close()
  })

  it('reads MILIBOT_VM_PORT_FIRST when allocating', () => {
    expect(readDaemonConfig({}).vmPortFirst).toBe(24000)
    const store = AppStore.open(':memory:', {
      vmPortFirst: readDaemonConfig({ MILIBOT_VM_PORT_FIRST: '47600' }).vmPortFirst,
    })
    store.insertWorkspace({ id: 'ws_a', name: 'a', color: 'blue', icon: null, dir: '/data/a' })
    expect(store.vmPortBase('ws_a')).toBe(47600)
    store.close()
  })

  it('moves a range whose ports another program took to the next free one above it', () => {
    const store = AppStore.open(':memory:')
    for (const id of ['ws_a', 'ws_b'])
      store.insertWorkspace({ id, name: id, color: 'blue', icon: null, dir: `/data/${id}` })
    expect(store.vmPortBase('ws_a')).toBe(24000)
    expect(store.vmPortBase('ws_b')).toBe(24100)
    expect(store.moveVmPortBase('ws_a')).toBe(24200)
    expect(store.vmPortBase('ws_a')).toBe(24200)
    expect(store.moveVmPortBase('ws_b')).toBe(24300)
    store.db.prepare('UPDATE workspaces SET vm_port_base = 65400 WHERE id = ?').run('ws_a')
    expect(() => store.moveVmPortBase('ws_a')).toThrow(/No free VM port range/)
    store.close()
  })
})
