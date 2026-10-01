// Stand-in for local-worker.ts in unit tests: same IPC protocol, no model. Vectors put the text length
// in the first dimension, so tests can check order and truncation. `CRASH` exits, `SLOW` takes 300 ms,
// `remoteHost: 'offline'` fails the load like an unreachable Hugging Face, `'slow'` takes 400 ms per
// progress step of the download.
const config = JSON.parse(process.argv[2])
const dims = config.model.nativeDimensions
let loaded = false
const cancelled = new Set()

function vector(text) {
  const v = new Float32Array(dims)
  v[0] = text.length
  v[1] = 1
  const n = Math.hypot(...v)
  return v.map((x) => x / n)
}

async function load(id) {
  if (config.remoteHost === 'offline') {
    process.send({ type: 'error', id, code: 'model_download_failed', message: 'fetch failed' })
    return false
  }
  if (!loaded) {
    for (const loadedBytes of [50, 100]) {
      if (config.remoteHost === 'slow') await new Promise((r) => setTimeout(r, 400))
      process.send({
        type: 'progress',
        progress: {
          modelId: config.model.repo,
          loadedBytes,
          totalBytes: 100,
          progress: loadedBytes / 100,
          file: null,
          done: loadedBytes === 100,
        },
      })
    }
    loaded = true
  }
  return true
}

process.on('message', async (message) => {
  if (message.type === 'load') {
    if (await load(message.id)) process.send({ type: 'loaded', id: message.id, loadMs: 1, downloaded: true })
  } else if (message.type === 'embed') {
    if (!(await load(message.id))) return
    if (message.texts.some((t) => t.includes('CRASH'))) process.exit(3)
    if (message.texts.some((t) => t.includes('SLOW'))) await new Promise((r) => setTimeout(r, 300))
    if (cancelled.delete(message.id)) {
      process.send({ type: 'error', id: message.id, code: 'aborted', message: 'embedding aborted' })
      return
    }
    const counts = message.texts.map((t) => t.length)
    const tokens = counts.reduce((s, n) => s + n, 0)
    process.send({ type: 'result', id: message.id, vectors: message.texts.map(vector), tokens, counts })
  } else if (message.type === 'cancel') {
    cancelled.add(message.id)
  } else if (message.type === 'stats') {
    process.send({
      type: 'stats',
      id: message.id,
      rssBytes: process.memoryUsage.rss(),
      peakRssBytes: process.resourceUsage().maxRSS * 1024,
    })
  }
})
process.on('disconnect', () => process.exit(0))
