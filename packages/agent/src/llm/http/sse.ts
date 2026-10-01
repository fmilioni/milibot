/** Yields the `data:` payload of each server-sent event (multi-line data joined with \n). */
export async function* readSseData(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder()
  let buffer = ''
  let data: string[] = []
  const reader = body.getReader()
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let index: number
      while ((index = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, index).replace(/\r$/, '')
        buffer = buffer.slice(index + 1)
        if (line === '') {
          if (data.length) yield data.join('\n')
          data = []
        } else if (line.startsWith('data:')) {
          data.push(line.slice(5).replace(/^ /, ''))
        }
      }
    }
    if (buffer.startsWith('data:')) data.push(buffer.slice(5).replace(/^ /, ''))
    if (data.length) yield data.join('\n')
  } finally {
    reader.releaseLock()
  }
}
