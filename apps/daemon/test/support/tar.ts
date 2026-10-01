/** Minimal ustar writer/reader (regular files only) for the fake `/workspace` archive. */
export function writeTar(files: Array<[string, string]>): Uint8Array {
  const blocks: Buffer[] = []
  for (const [name, content] of files) {
    const data = Buffer.from(content)
    const header = Buffer.alloc(512)
    header.write(`./${name}`, 0, 100)
    header.write('0000644\0', 100)
    header.write('0000000\0', 108)
    header.write('0000000\0', 116)
    header.write(`${data.length.toString(8).padStart(11, '0')}\0`, 124)
    header.write('00000000000\0', 136)
    header.write('        ', 148)
    header.write('0', 156)
    header.write('ustar\0', 257)
    header.write('00', 263)
    let sum = 0
    for (const byte of header) sum += byte
    header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148)
    blocks.push(header, data, Buffer.alloc((512 - (data.length % 512)) % 512))
  }
  blocks.push(Buffer.alloc(1024))
  return new Uint8Array(Buffer.concat(blocks))
}

export function readTar(bytes: Uint8Array): Map<string, string> {
  const buffer = Buffer.from(bytes)
  const files = new Map<string, string>()
  for (let offset = 0; offset + 512 <= buffer.length;) {
    const header = buffer.subarray(offset, offset + 512)
    if (header.every((b) => b === 0)) break
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/s, '').replace(/^\.\//, '')
    const size = parseInt(header.subarray(124, 136).toString('utf8').replace(/\0.*$/s, '').trim(), 8)
    files.set(name, buffer.subarray(offset + 512, offset + 512 + size).toString('utf8'))
    offset += 512 + Math.ceil(size / 512) * 512
  }
  return files
}
