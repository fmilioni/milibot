// Runs in the VM (`node -e`, as the bot): downloads the URL of the JSON request on stdin (see
// `fetchScriptInput`) and prints one JSON line. Every address a hop connects to is checked against `blocked`
// (the `lookup` hook for names, before connecting for IP literals, which Node never passes to `lookup`);
// redirects are followed by hand; the body is capped after decompression and comes back gzipped in base64.
const http = require('node:http'),
  https = require('node:https'),
  dns = require('node:dns')
const net = require('node:net'),
  zlib = require('node:zlib')
const out = (o) => {
  process.stdout.write(JSON.stringify(o) + '\n')
}
let raw = ''
process.stdin
  .on('data', (c) => {
    raw += c
  })
  .on('end', () => {
    main(JSON.parse(raw)).then(out, (err) => out(failure(err)))
  })
function failure(err) {
  const code = String((err && err.code) || '')
  const message = String((err && err.message) || err)
  if (code === 'EBLOCKED') return { ok: false, code: 'blocked_address', message }
  if (code === 'ETIMEOUT' || (err && err.name === 'AbortError'))
    return { ok: false, code: 'timeout', message: 'timed out' }
  if (code === 'EREDIRECTS') return { ok: false, code: 'too_many_redirects', message }
  if (code === 'ESCHEME') return { ok: false, code: 'http_scheme', message }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN' || code === 'ENODATA')
    return { ok: false, code: 'dns', message: 'host not found' }
  if (/CERT|TLS|SSL|EPROTO/.test(code) || /certificate|SSL|TLS/i.test(message))
    return { ok: false, code: 'tls', message }
  return { ok: false, code: 'connect', message: code ? code + ': ' + message : message }
}
async function main(req) {
  const list = new net.BlockList()
  for (const [address, prefix, family] of req.blocked) list.addSubnet(address, prefix, family)
  const blocked = (ip) => {
    if (req.allowPrivate) return false
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip)
    if (mapped) return list.check(mapped[1], 'ipv4')
    const family = net.isIP(ip)
    return family === 0 || list.check(ip, family === 4 ? 'ipv4' : 'ipv6')
  }
  const blockedError = (ip) =>
    Object.assign(new Error('refused to connect to a local address (' + ip + ')'), { code: 'EBLOCKED' })
  const lookup = (host, opts, cb) =>
    dns.lookup(host, { all: true, verbatim: true }, (err, addrs) => {
      if (err) return cb(err)
      const bad = addrs.find((a) => blocked(a.address))
      if (bad) return cb(blockedError(bad.address))
      if (opts && opts.all) return cb(null, addrs)
      cb(null, addrs[0].address, addrs[0].family)
    })
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), req.timeoutMs)
  try {
    let url = new URL(req.url)
    let fallback = !!req.httpFallback
    const redirects = []
    for (;;) {
      if (url.protocol !== 'https:' && url.protocol !== 'http:')
        throw Object.assign(new Error('redirected to ' + url.protocol), { code: 'ESCHEME' })
      const host = url.hostname.replace(/^\[|\]$/g, '')
      if (net.isIP(host) && blocked(host)) throw blockedError(host)
      let res
      try {
        res = await get(url, lookup, req, abort.signal)
      } catch (err) {
        const code = String((err && err.code) || '')
        if (
          !fallback ||
          url.protocol !== 'https:' ||
          abort.signal.aborted ||
          code === 'EBLOCKED' ||
          code === 'ENOTFOUND'
        )
          throw err
        fallback = false
        url = new URL(url.href.replace(/^https:/, 'http:'))
        continue
      }
      fallback = false
      const location = res.headers.location
      if (res.statusCode >= 300 && res.statusCode < 400 && location) {
        res.resume()
        if (redirects.length >= req.maxRedirects)
          throw Object.assign(new Error('more than ' + req.maxRedirects + ' redirects'), {
            code: 'EREDIRECTS',
          })
        url = new URL(location, url)
        redirects.push(url.href)
        continue
      }
      const { body, truncated } = await readBody(res, req.maxBytes)
      const type = String(res.headers['content-type'] || '')
      const charset = /charset=["']?([\w-]+)/i.exec(type)
      return {
        ok: true,
        status: res.statusCode,
        url: url.href,
        redirects,
        contentType: type.split(';')[0].trim().toLowerCase() || null,
        charset: charset ? charset[1].toLowerCase() : null,
        truncated,
        bodyGz: zlib.gzipSync(body).toString('base64'),
      }
    }
  } catch (err) {
    if (abort.signal.aborted) throw Object.assign(new Error('timed out'), { code: 'ETIMEOUT' })
    throw err
  } finally {
    clearTimeout(timer)
  }
}
function get(url, lookup, req, signal) {
  return new Promise((resolve, reject) => {
    const mod = url.protocol === 'https:' ? https : http
    const r = mod.request(
      url,
      {
        method: 'GET',
        lookup,
        signal,
        headers: {
          'user-agent': req.userAgent,
          accept:
            'text/markdown, text/html;q=0.9, application/xhtml+xml;q=0.9, application/pdf;q=0.8, */*;q=0.5',
          'accept-language': req.acceptLanguage,
          'accept-encoding': 'gzip, deflate, br',
        },
      },
      resolve,
    )
    r.on('error', reject)
    r.end()
  })
}
function readBody(res, maxBytes) {
  return new Promise((resolve, reject) => {
    const encoding = String(res.headers['content-encoding'] || '').toLowerCase()
    let stream = res
    if (encoding === 'gzip' || encoding === 'x-gzip') stream = res.pipe(zlib.createGunzip())
    else if (encoding === 'deflate') stream = res.pipe(zlib.createInflate())
    else if (encoding === 'br') stream = res.pipe(zlib.createBrotliDecompress())
    const chunks = []
    let size = 0
    let done = false
    const finish = (truncated) => {
      if (done) return
      done = true
      resolve({ body: Buffer.concat(chunks), truncated })
    }
    stream.on('data', (chunk) => {
      if (done) return
      const room = maxBytes - size
      chunks.push(chunk.length > room ? chunk.subarray(0, room) : chunk)
      size += Math.min(chunk.length, room)
      if (size >= maxBytes) {
        finish(true)
        res.destroy()
      }
    })
    stream.on('end', () => finish(false))
    stream.on('error', (err) => {
      if (size > 0) finish(true)
      else if (!done) {
        done = true
        reject(err)
      }
    })
    res.on('error', (err) => {
      if (size > 0) finish(true)
      else if (!done) {
        done = true
        reject(err)
      }
    })
  })
}
