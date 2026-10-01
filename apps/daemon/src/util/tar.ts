export interface TarEntry {
  path: string
  data: Uint8Array
  mode: number
}

function octal(value: number, width: number): string {
  return `${value.toString(8).padStart(width - 1, '0')}\0`
}

/** `name` + `prefix` of a ustar header; null when the path does not fit. */
function splitPath(path: string): { name: string; prefix: string } | null {
  if (Buffer.byteLength(path) <= 100) return { name: path, prefix: '' }
  for (let i = path.length - 1; i > 0; i--) {
    if (path[i] !== '/') continue
    const prefix = path.slice(0, i)
    const name = path.slice(i + 1)
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100 && name) return { name, prefix }
  }
  return null
}

export function fitsTar(path: string): boolean {
  return splitPath(path) !== null
}

/** A plain ustar archive of regular files (parent folders are created on extraction). */
export function buildTar(entries: readonly TarEntry[], mtime = Math.floor(Date.now() / 1000)): Buffer {
  const blocks: Buffer[] = []
  for (const entry of entries) {
    const split = splitPath(entry.path)
    if (!split) throw new Error(`path too long for tar: ${entry.path}`)
    const header = Buffer.alloc(512)
    header.write(split.name, 0, 100, 'utf8')
    header.write(octal(entry.mode & 0o7777, 8), 100, 8, 'ascii')
    header.write(octal(0, 8), 108, 8, 'ascii')
    header.write(octal(0, 8), 116, 8, 'ascii')
    header.write(octal(entry.data.length, 12), 124, 12, 'ascii')
    header.write(octal(mtime, 12), 136, 12, 'ascii')
    header.write('        ', 148, 8, 'ascii')
    header.write('0', 156, 1, 'ascii')
    header.write('ustar\0', 257, 6, 'ascii')
    header.write('00', 263, 2, 'ascii')
    header.write('root', 265, 32, 'ascii')
    header.write('root', 297, 32, 'ascii')
    header.write(split.prefix, 345, 155, 'utf8')
    let sum = 0
    for (const byte of header) sum += byte
    header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii')
    blocks.push(header, Buffer.from(entry.data))
    const pad = (512 - (entry.data.length % 512)) % 512
    if (pad) blocks.push(Buffer.alloc(pad))
  }
  blocks.push(Buffer.alloc(1024))
  return Buffer.concat(blocks)
}
