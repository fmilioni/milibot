/** Float32 vectors as one base64 string (the runtime IPC channel is JSON). */
export function encodeVectors(vectors: Float32Array[]): string {
  const dims = vectors[0]?.length ?? 0
  const all = new Float32Array(vectors.length * dims)
  vectors.forEach((v, i) => all.set(v, i * dims))
  return Buffer.from(all.buffer, all.byteOffset, all.byteLength).toString('base64')
}

export function decodeVectors(base64: string, dimensions: number): Float32Array[] {
  const bytes = Buffer.from(base64, 'base64')
  const all = new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength))
  const out: Float32Array[] = []
  for (let offset = 0; dimensions > 0 && offset < all.length; offset += dimensions)
    out.push(all.slice(offset, offset + dimensions))
  return out
}
