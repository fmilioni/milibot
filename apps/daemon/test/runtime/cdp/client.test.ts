import { describe, expect, it } from 'vitest'

import { CdpClient } from '../../../src/runtime/cdp/client'
import { fakeChrome } from '../../support/fake-chrome'

describe('CdpClient', () => {
  it('matches responses to requests, relays tab lists and fails pending calls when closed', async () => {
    const { channel } = fakeChrome((method) => {
      if (method === 'Browser.getVersion') return { product: 'Chrome/150' }
      throw new Error('nope')
    })
    const client = new CdpClient(channel)
    await client.open()
    await expect(client.send('Browser.getVersion')).resolves.toEqual({ product: 'Chrome/150' })
    await expect(client.send('Bad.method')).rejects.toThrow('nope')
    expect((await client.tabs()).map((t) => t.id)).toEqual(['T1', 'S1'])
    await client.close()
    await expect(client.send('Browser.getVersion')).rejects.toThrow('closed')
  })

  it('evaluates in the page and turns script exceptions into errors', async () => {
    const calls: Array<Record<string, unknown>> = []
    const { channel } = fakeChrome((method, params) => {
      calls.push(params)
      if (params.expression === 'fail()')
        return { exceptionDetails: { text: 'Uncaught', exception: { description: 'ReferenceError: fail' } } }
      return { result: { value: 42 } }
    })
    const client = new CdpClient(channel)
    await client.open()
    await expect(client.evaluate('6 * 7', 'S1', { awaitPromise: true })).resolves.toBe(42)
    expect(calls.at(-1)).toEqual({ expression: '6 * 7', returnByValue: true, awaitPromise: true })
    await expect(client.evaluate('fail()', 'S1')).rejects.toThrow('ReferenceError: fail')
    await client.close()
  })
})
