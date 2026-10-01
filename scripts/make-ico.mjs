#!/usr/bin/env node
// Packs PNG files into a Windows .ico (PNG-compressed entries, supported since Vista).
import { readFileSync, writeFileSync } from 'node:fs'

const [out, ...inputs] = process.argv.slice(2)
if (!out || inputs.length === 0) {
  console.error('usage: make-ico.mjs out.ico in.png…')
  process.exit(2)
}
const images = inputs.map((file) => {
  const data = readFileSync(file)
  if (data.readUInt32BE(0) !== 0x89504e47) throw new Error(`${file} is not a PNG`)
  return { data, width: data.readUInt32BE(16), height: data.readUInt32BE(20) }
})
const header = Buffer.alloc(6)
header.writeUInt16LE(0, 0)
header.writeUInt16LE(1, 2)
header.writeUInt16LE(images.length, 4)
let offset = 6 + 16 * images.length
const entries = images.map(({ data, width, height }) => {
  const entry = Buffer.alloc(16)
  entry[0] = width >= 256 ? 0 : width
  entry[1] = height >= 256 ? 0 : height
  entry.writeUInt16LE(1, 4)
  entry.writeUInt16LE(32, 6)
  entry.writeUInt32LE(data.length, 8)
  entry.writeUInt32LE(offset, 12)
  offset += data.length
  return entry
})
writeFileSync(out, Buffer.concat([header, ...entries, ...images.map((i) => i.data)]))
