import type { VmInfo } from '@milibot/shared'
import { describe, expect, it } from 'vitest'

import { VmCopyQueue } from '../../../src/runtime/vm/copy-queue'

function fakeVm(running: boolean) {
  let state = running ? 'running' : 'stopped'
  const listeners = new Set<(info: VmInfo) => void>()
  return {
    status: () => ({ state }) as VmInfo,
    subscribe: (listener: (info: VmInfo) => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    set(next: string) {
      state = next
      for (const l of listeners) l({ state } as VmInfo)
    },
  }
}

describe('VmCopyQueue', () => {
  it('runs when the VM comes up and on kicks, never while it is off', async () => {
    const vm = fakeVm(false)
    let runs = 0
    const queue = new VmCopyQueue({ name: 'copy', vm, run: async () => void runs++ })
    queue.start()
    await queue.kick()
    expect(runs).toBe(0)
    vm.set('running')
    await queue.idle()
    expect(runs).toBe(1)
    await queue.kick()
    expect(runs).toBe(2)
    await queue.stop()
    await queue.kick()
    expect(runs).toBe(2)
  })

  it('runs once more after a run that was kicked meanwhile, sharing that later run', async () => {
    const vm = fakeVm(true)
    let release: () => void = () => undefined
    let runs = 0
    const queue = new VmCopyQueue({
      name: 'copy',
      vm,
      run: () => {
        runs++
        return runs === 1 ? new Promise<void>((resolve) => (release = resolve)) : Promise.resolve()
      },
    })
    const first = queue.kick()
    const second = queue.kick()
    const third = queue.kick()
    expect(second).toBe(third)
    release()
    await first
    await second
    expect(runs).toBe(2)
  })
})
