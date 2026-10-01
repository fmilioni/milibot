// Runs in the VM as `agent`, started by `agy` for the `milibot` entry of its global MCP config: an MCP server on
// stdio that joins the servers of one lane, named by the JSON file in MILIBOT_MCP_CONFIG (`agy` passes its env
// on, and each lane's process has its own file and token). Milibot's own tools keep their names; another
// server's become `<slug>__<tool>`, minus the ones its `disabledTools` lists. Without a config (someone runs
// `agy` by hand) it serves no tools.
const fs = require('node:fs'),
  readline = require('node:readline'),
  { spawn } = require('node:child_process')

const MILIBOT = 'milibot'
const SEP = '__'
const PROTOCOL = '2025-06-18'
const INIT_TIMEOUT_MS = 30000

const log = (...parts) => process.stderr.write('[milibot-mcp-bridge] ' + parts.join(' ') + '\n')
const send = (message) => process.stdout.write(JSON.stringify(message) + '\n')

function loadConfig() {
  const file = process.env.MILIBOT_MCP_CONFIG
  if (!file) return {}
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')).servers || {}
  } catch (err) {
    log('cannot read', file + ':', err.message)
    return {}
  }
}

function withTimeout(promise, ms, what) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(what + ' timed out')), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

/** JSON-RPC over newline-delimited stdio of a child process. */
function stdioClient(server) {
  const child = spawn(server.command, server.args || [], {
    env: { ...process.env, ...(server.env || {}) },
    stdio: ['pipe', 'pipe', 'inherit'],
    windowsHide: true,
  })
  const pending = new Map()
  let nextId = 1
  child.on('exit', () => {
    for (const { reject } of pending.values()) reject(new Error('server exited'))
    pending.clear()
  })
  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    let message
    try {
      message = JSON.parse(line)
    } catch {
      return
    }
    if (message.method && message.id !== undefined) {
      const result =
        message.method === 'roots/list'
          ? { result: { roots: [] } }
          : { error: { code: -32601, message: 'not supported' } }
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, ...result }) + '\n')
      return
    }
    const waiter = pending.get(message.id)
    if (!waiter) return
    pending.delete(message.id)
    if (message.error) waiter.reject(new Error(message.error.message || 'error'))
    else waiter.resolve(message.result)
  })
  return {
    request(method, params) {
      const id = nextId++
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject })
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
      })
    },
    notify(method, params) {
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n')
    },
  }
}

/** The JSON-RPC answer to `id` in an SSE body (or a plain JSON one). */
async function readAnswer(res, id) {
  const type = res.headers.get('content-type') || ''
  if (!type.includes('text/event-stream')) return res.json()
  let buffer = ''
  const decoder = new TextDecoder()
  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true })
    let end
    while ((end = buffer.indexOf('\n\n')) >= 0) {
      const event = buffer.slice(0, end)
      buffer = buffer.slice(end + 2)
      const data = event
        .split('\n')
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).trimStart())
        .join('\n')
      if (!data) continue
      const message = JSON.parse(data)
      if (message.id === id) return message
    }
  }
  throw new Error('no answer in the event stream')
}

/** Streamable HTTP: one POST per message, the session id kept from `initialize`. */
function httpClient(server) {
  let session = null
  let nextId = 1
  const post = async (body) => {
    const headers = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': PROTOCOL,
      ...(server.headers || {}),
      ...(session ? { 'mcp-session-id': session } : {}),
    }
    const res = await fetch(server.url, { method: 'POST', headers, body: JSON.stringify(body) })
    if (res.headers.get('mcp-session-id')) session = res.headers.get('mcp-session-id')
    if (!res.ok && res.status !== 202) throw new Error('HTTP ' + res.status)
    return res
  }
  return {
    async request(method, params) {
      const id = nextId++
      const message = await readAnswer(await post({ jsonrpc: '2.0', id, method, params }), id)
      if (message.error) throw new Error(message.error.message || 'error')
      return message.result
    },
    notify(method, params) {
      post({ jsonrpc: '2.0', method, params }).then(
        (res) => res.body && res.body.cancel(),
        () => undefined,
      )
    },
  }
}

/** Legacy SSE: answers arrive on the GET stream, messages go to the endpoint it names. */
function sseClient(server) {
  const pending = new Map()
  let nextId = 1
  let endpoint = null
  const ready = (async () => {
    const res = await fetch(server.url, {
      headers: { accept: 'text/event-stream', ...(server.headers || {}) },
    })
    if (!res.ok) throw new Error('HTTP ' + res.status)
    let resolveEndpoint
    const found = new Promise((resolve) => (resolveEndpoint = resolve))
    ;(async () => {
      let buffer = ''
      const decoder = new TextDecoder()
      for await (const chunk of res.body) {
        buffer += decoder.decode(chunk, { stream: true })
        let end
        while ((end = buffer.indexOf('\n\n')) >= 0) {
          const lines = buffer.slice(0, end).split('\n')
          buffer = buffer.slice(end + 2)
          const name = (lines.find((l) => l.startsWith('event:')) || 'event: message').slice(6).trim()
          const data = lines
            .filter((l) => l.startsWith('data:'))
            .map((l) => l.slice(5).trimStart())
            .join('\n')
          if (name === 'endpoint') resolveEndpoint(new URL(data, server.url).toString())
          else if (data) {
            const message = JSON.parse(data)
            const waiter = pending.get(message.id)
            if (!waiter) continue
            pending.delete(message.id)
            if (message.error) waiter.reject(new Error(message.error.message || 'error'))
            else waiter.resolve(message.result)
          }
        }
      }
    })().catch((err) => log('sse stream of', server.url, 'ended:', err.message))
    endpoint = await found
  })()
  const post = async (body) => {
    await ready
    await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(server.headers || {}) },
      body: JSON.stringify(body),
    })
  }
  return {
    request(method, params) {
      const id = nextId++
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject })
        post({ jsonrpc: '2.0', id, method, params }).catch(reject)
      })
    },
    notify(method, params) {
      post({ jsonrpc: '2.0', method, params }).catch(() => undefined)
    },
  }
}

function clientFor(server) {
  if (server.type === 'stdio') return stdioClient(server)
  if (server.type === 'sse') return sseClient(server)
  return httpClient(server)
}

const servers = loadConfig()
/** name → { client, tools } of the servers that answered `initialize` and `tools/list`. */
let connected = null

function connect() {
  connected ??= Promise.all(
    Object.entries(servers).map(async ([name, server]) => {
      try {
        const client = clientFor(server)
        await withTimeout(
          client.request('initialize', {
            protocolVersion: PROTOCOL,
            capabilities: {},
            clientInfo: { name: 'milibot-mcp-bridge', version: '1' },
          }),
          INIT_TIMEOUT_MS,
          name + ' initialize',
        )
        client.notify('notifications/initialized', {})
        const off = new Set(server.disabledTools || [])
        const tools = []
        let cursor
        do {
          const page = await withTimeout(
            client.request('tools/list', cursor ? { cursor } : {}),
            INIT_TIMEOUT_MS,
            name + ' tools/list',
          )
          tools.push(...(page.tools || []).filter((t) => !off.has(t.name)))
          cursor = page.nextCursor
        } while (cursor)
        return [name, { client, tools }]
      } catch (err) {
        log('server', name, 'unavailable:', err.message)
        return null
      }
    }),
  ).then((entries) => new Map(entries.filter(Boolean)))
  return connected
}

const exposed = (name, tool) => (name === MILIBOT ? tool : name + SEP + tool)

async function handle(message) {
  switch (message.method) {
    case 'initialize':
      void connect()
      return {
        protocolVersion: (message.params && message.params.protocolVersion) || PROTOCOL,
        capabilities: { tools: {} },
        serverInfo: { name: MILIBOT, version: '1' },
      }
    case 'ping':
      return {}
    case 'tools/list': {
      const all = await connect()
      return {
        tools: [...all].flatMap(([name, { tools }]) =>
          tools.map((t) => ({ ...t, name: exposed(name, t.name) })),
        ),
      }
    }
    case 'tools/call': {
      const all = await connect()
      const full = String((message.params && message.params.name) || '')
      const split = full.indexOf(SEP)
      const prefix = split < 0 ? null : full.slice(0, split)
      const [name, tool] =
        prefix && prefix !== MILIBOT && all.has(prefix)
          ? [prefix, full.slice(split + SEP.length)]
          : [MILIBOT, full]
      const target = all.get(name)
      if (!target) throw Object.assign(new Error('unknown tool ' + full), { code: -32602 })
      return target.client.request('tools/call', { ...message.params, name: tool })
    }
    case 'resources/list':
      return { resources: [] }
    case 'resources/templates/list':
      return { resourceTemplates: [] }
    case 'prompts/list':
      return { prompts: [] }
    default:
      throw Object.assign(new Error('method not found: ' + message.method), { code: -32601 })
  }
}

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  let message
  try {
    message = JSON.parse(line)
  } catch {
    return
  }
  if (message.id === undefined || !message.method) return
  handle(message).then(
    (result) => send({ jsonrpc: '2.0', id: message.id, result }),
    (err) =>
      send({ jsonrpc: '2.0', id: message.id, error: { code: err.code || -32603, message: err.message } }),
  )
})
process.stdin.on('end', () => process.exit(0))
