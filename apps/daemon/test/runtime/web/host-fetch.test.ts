import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { fetchOnHost } from '../../../src/runtime/web/host-fetch'

let server: Server
let url: string

beforeAll(async () => {
  server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end('<html><body><p>Hello from the host</p></body></html>')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/page`
})

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve))
})

const request = (target: string) => ({ url: target, httpFallback: true, acceptLanguage: 'en-US' })

describe('fetchOnHost', () => {
  it("downloads with the VM's script run by the daemon's Node", async () => {
    const page = await fetchOnHost(request(url), AbortSignal.timeout(20_000), true)

    expect(page.status).toBe(200)
    expect(page.contentType).toMatch(/text\/html/)
    expect(page.body.toString('utf8')).toContain('Hello from the host')
  })

  it('refuses local addresses like the VM does', async () => {
    const refused = fetchOnHost(request(url), AbortSignal.timeout(20_000))

    await expect(refused).rejects.toThrow('(blocked_address): web_fetch reads public sites only.')
  })

  it('stops when the turn is stopped', async () => {
    const controller = new AbortController()
    controller.abort(new Error('stopped'))

    await expect(fetchOnHost(request(url), controller.signal, true)).rejects.toThrow('stopped')
  })
})
