import { crc32, deflateSync, inflateSync } from 'node:zlib'

/** Decoded 8-bit RGB image. */
export interface RgbImage {
  width: number
  height: number
  /** width * height * 3 bytes. */
  pixels: Uint8Array
}

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c
}

/**
 * Decodes a non-interlaced 8-bit PNG (gray, RGB, palette, with or without alpha) to RGB; alpha is
 * dropped. Returns null for anything else (the caller keeps the original image).
 */
export function decodePng(png: Uint8Array): RgbImage | null {
  const buf = Buffer.from(png.buffer, png.byteOffset, png.byteLength)
  if (buf.length < 33 || !buf.subarray(0, 8).equals(SIGNATURE)) return null
  let offset = 8
  let width = 0
  let height = 0
  let colorType = -1
  let palette: Buffer | null = null
  const idat: Buffer[] = []
  while (offset + 8 <= buf.length) {
    const length = buf.readUInt32BE(offset)
    const type = buf.toString('ascii', offset + 4, offset + 8)
    const data = buf.subarray(offset + 8, offset + 8 + length)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      const depth = data[8]
      colorType = data[9] ?? -1
      if (depth !== 8 || data[12] !== 0 || CHANNELS[colorType] === undefined) return null
    } else if (type === 'PLTE') {
      palette = data
    } else if (type === 'IDAT') {
      idat.push(data)
    } else if (type === 'IEND') {
      break
    }
    offset += 12 + length
  }
  const channels = CHANNELS[colorType]
  if (!channels || width <= 0 || height <= 0 || (colorType === 3 && !palette)) return null
  let raw: Buffer
  try {
    raw = inflateSync(Buffer.concat(idat))
  } catch {
    return null
  }
  const stride = width * channels
  if (raw.length < height * (stride + 1)) return null
  const current = Buffer.alloc(stride)
  const previous = Buffer.alloc(stride)
  const pixels = new Uint8Array(width * height * 3)
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1))
    for (let i = 0; i < stride; i++) {
      const left = i >= channels ? (current[i - channels] as number) : 0
      const up = previous[i] as number
      const upLeft = i >= channels ? (previous[i - channels] as number) : 0
      const x = line[i] as number
      let value: number
      switch (filter) {
        case 0:
          value = x
          break
        case 1:
          value = x + left
          break
        case 2:
          value = x + up
          break
        case 3:
          value = x + ((left + up) >> 1)
          break
        case 4:
          value = x + paeth(left, up, upLeft)
          break
        default:
          return null
      }
      current[i] = value & 0xff
    }
    for (let px = 0; px < width; px++) {
      const out = (y * width + px) * 3
      const at = px * channels
      if (colorType === 3) {
        const index = (current[at] as number) * 3
        pixels[out] = palette?.[index] ?? 0
        pixels[out + 1] = palette?.[index + 1] ?? 0
        pixels[out + 2] = palette?.[index + 2] ?? 0
      } else if (channels <= 2) {
        const gray = current[at] as number
        pixels[out] = gray
        pixels[out + 1] = gray
        pixels[out + 2] = gray
      } else {
        pixels[out] = current[at] as number
        pixels[out + 1] = current[at + 1] as number
        pixels[out + 2] = current[at + 2] as number
      }
    }
    current.copy(previous)
  }
  return { width, height, pixels }
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([length, body, crc])
}

export function encodePng(image: RgbImage): Uint8Array {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(image.width, 0)
  header.writeUInt32BE(image.height, 4)
  header[8] = 8
  header[9] = 2
  const stride = image.width * 3
  const raw = Buffer.alloc(image.height * (stride + 1))
  for (let y = 0; y < image.height; y++) {
    raw.set(image.pixels.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1)
  }
  return new Uint8Array(
    Buffer.concat([
      SIGNATURE,
      chunk('IHDR', header),
      chunk('IDAT', deflateSync(raw)),
      chunk('IEND', Buffer.alloc(0)),
    ]),
  )
}

/** Solid-color RGB PNG (used by connection tests and fixtures). */
export function solidPng(width: number, height: number, rgb: [number, number, number]): Uint8Array {
  const pixels = new Uint8Array(width * height * 3)
  for (let i = 0; i < pixels.length; i += 3) pixels.set(rgb, i)
  return encodePng({ width, height, pixels })
}

export function pngSize(png: Uint8Array): { width: number; height: number } | null {
  const buf = Buffer.from(png.buffer, png.byteOffset, png.byteLength)
  if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47 || buf.toString('ascii', 12, 16) !== 'IHDR') {
    return null
  }
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
}
