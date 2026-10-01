import { spawn } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { gzipSync } from 'node:zlib'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { FETCH_SCRIPT } from '../../../src/runtime/web/scripts/fetch.generated'
import { fetchScriptInput, parseFetchOutput } from '../../../src/runtime/web/vm-fetch'

let server: Server
let base = ''

beforeAll(async () => {
  server = createServer((req, res) => {
    const path = req.url ?? '/'
    if (path === '/page') {
      res.writeHead(200, { 'content-type': 'text/html; charset=ISO-8859-1', 'content-encoding': 'gzip' })
      res.end(gzipSync(Buffer.from('<p>caf\xe9</p>', 'latin1')))
    } else if (path.startsWith('/hop/')) {
      const n = Number(path.slice(5))
      res.writeHead(302, { location: n > 0 ? `/hop/${n - 1}` : '/page' })
      res.end()
    } else if (path === '/big') {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('x'.repeat(50_000))
    } else if (path === '/slow') {
      setTimeout(() => res.end('late'), 3_000)
    } else if (path === '/headers') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(req.headers))
    } else {
      res.writeHead(404)
      res.end('missing')
    }
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(() => {
  server.closeAllConnections()
  server.close()
})

function run(url: string, overrides: Record<string, unknown> = {}) {
  const input = {
    ...JSON.parse(fetchScriptInput({ url, httpFallback: false, acceptLanguage: 'en' }, true)),
    ...overrides,
  }
  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', FETCH_SCRIPT], { windowsHide: true })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (c) => (stdout += c))
    child.stderr.on('data', (c) => (stderr += c))
    child.on('error', reject)
    child.on('close', () => resolve({ stdout, stderr }))
    child.stdin.end(JSON.stringify(input))
  })
}

async function fetchIt(url: string, overrides: Record<string, unknown> = {}) {
  const { stdout, stderr } = await run(url, overrides)
  return parseFetchOutput(stdout, stderr)
}

describe('FETCH_SCRIPT', () => {
  it('decompresses the body and reports type and charset', async () => {
    const result = await fetchIt(`${base}/page`)
    expect(result).toMatchObject({
      status: 200,
      contentType: 'text/html',
      charset: 'iso-8859-1',
      truncated: false,
    })
    expect(result.body.toString('latin1')).toBe('<p>caf\xe9</p>')
  })

  it('follows redirects up to the limit and lists them', async () => {
    const result = await fetchIt(`${base}/hop/2`)
    expect(result.url).toBe(`${base}/page`)
    expect(result.redirects).toEqual([`${base}/hop/1`, `${base}/hop/0`, `${base}/page`])
    await expect(fetchIt(`${base}/hop/9`)).rejects.toThrow('too_many_redirects')
  })

  it('cuts the body at the byte limit', async () => {
    const result = await fetchIt(`${base}/big`, { maxBytes: 1_000 })
    expect(result.truncated).toBe(true)
    expect(result.body.length).toBe(1_000)
  })

  it('gives up at the deadline', async () => {
    await expect(fetchIt(`${base}/slow`, { timeoutMs: 300 })).rejects.toThrow('(timeout)')
  })

  it('sends a browser user agent and asks for Markdown first', async () => {
    const headers = JSON.parse((await fetchIt(`${base}/headers`)).body.toString()) as Record<string, string>
    expect(headers['user-agent']).toMatch(/Chrome/)
    expect(headers.accept?.startsWith('text/markdown')).toBe(true)
  })

  it('refuses local addresses by IP literal and by name', async () => {
    await expect(fetchIt(`${base}/page`, { allowPrivate: false })).rejects.toThrow('blocked_address')
    const byName = base.replace('127.0.0.1', 'localhost')
    await expect(fetchIt(`${byName}/page`, { allowPrivate: false })).rejects.toThrow('blocked_address')
  })
})

describe('parseFetchOutput', () => {
  it('decodes the body and maps failures to messages the bot can act on', () => {
    const line = JSON.stringify({
      ok: true,
      status: 200,
      url: 'https://a.dev/',
      redirects: [],
      contentType: 'text/html',
      charset: 'utf-8',
      truncated: false,
      bodyGz: gzipSync('<p>hi</p>').toString('base64'),
    })
    expect(parseFetchOutput(`noise\n${line}\n`, '').body.toString()).toBe('<p>hi</p>')
    expect(() => parseFetchOutput('{"ok":false,"code":"blocked_address","message":"x"}', '')).toThrow(
      'web_fetch reads public sites only',
    )
    expect(() => parseFetchOutput('', 'sh: node: command not found')).toThrow('node is missing in the VM')
  })
})
