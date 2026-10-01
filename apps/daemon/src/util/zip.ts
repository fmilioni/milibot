import { createReadStream, createWriteStream } from 'node:fs'
import { type FileHandle, open } from 'node:fs/promises'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { crc32, createDeflateRaw, createInflateRaw, deflateRawSync } from 'node:zlib'

const LOCAL_HEADER = 0x04034b50
const DATA_DESCRIPTOR = 0x08074b50
const CENTRAL_HEADER = 0x02014b50
const END_OF_CENTRAL = 0x06054b50
const ZIP64_END = 0x06064b50
const ZIP64_LOCATOR = 0x07064b50
const MAX_32 = 0xffffffff
const MAX_16 = 0xffff
/** Data descriptor follows the data (bit 3) + UTF-8 names (bit 11). */
const FLAG_DESCRIPTOR = 0x0008
const FLAG_UTF8 = 0x0800
const STORE = 0
const DEFLATE = 8

interface CentralEntry {
  name: Buffer
  method: number
  flags: number
  crc: number
  compressedSize: number
  size: number
  offset: number
  time: number
  date: number
  zip64: boolean
}

function dosDateTime(at: Date): { time: number; date: number } {
  return {
    time: (at.getHours() << 11) | (at.getMinutes() << 5) | Math.floor(at.getSeconds() / 2),
    date: ((Math.max(at.getFullYear(), 1980) - 1980) << 9) | ((at.getMonth() + 1) << 5) | at.getDate(),
  }
}

/**
 * Minimal streaming ZIP writer: small files in memory, big ones streamed with a data descriptor and ZIP64
 * sizes (a `/workspace` archive can pass 4 GB). One pass, nothing staged on disk.
 */
export class ZipWriter {
  private offset = 0
  private readonly entries: CentralEntry[] = []
  private readonly stamp: { time: number; date: number }

  private constructor(
    private readonly file: FileHandle,
    now: Date,
  ) {
    this.stamp = dosDateTime(now)
  }

  static async create(path: string, now = new Date()): Promise<ZipWriter> {
    return new ZipWriter(await open(path, 'w', 0o600), now)
  }

  private async write(buffer: Buffer): Promise<void> {
    let written = 0
    while (written < buffer.length) {
      const { bytesWritten } = await this.file.write(buffer, written, buffer.length - written)
      written += bytesWritten
    }
    this.offset += buffer.length
  }

  async addBuffer(name: string, data: Buffer | string, options: { deflate?: boolean } = {}): Promise<void> {
    const raw = typeof data === 'string' ? Buffer.from(data) : data
    const compressed = options.deflate ? deflateRawSync(raw) : raw
    const entry: CentralEntry = {
      name: Buffer.from(name),
      method: options.deflate ? DEFLATE : STORE,
      flags: FLAG_UTF8,
      crc: crc32(raw),
      compressedSize: compressed.length,
      size: raw.length,
      offset: this.offset,
      ...this.stamp,
      zip64: false,
    }
    const header = Buffer.alloc(30)
    header.writeUInt32LE(LOCAL_HEADER, 0)
    header.writeUInt16LE(20, 4)
    header.writeUInt16LE(entry.flags, 6)
    header.writeUInt16LE(entry.method, 8)
    header.writeUInt16LE(entry.time, 10)
    header.writeUInt16LE(entry.date, 12)
    header.writeUInt32LE(entry.crc, 14)
    header.writeUInt32LE(entry.compressedSize, 18)
    header.writeUInt32LE(entry.size, 22)
    header.writeUInt16LE(entry.name.length, 26)
    header.writeUInt16LE(0, 28)
    await this.write(Buffer.concat([header, entry.name]))
    await this.write(compressed)
    this.entries.push(entry)
  }

  /** Streams an entry of unknown size; `onBytes` gets the uncompressed bytes as they are read. */
  async addStream(
    name: string,
    source: AsyncIterable<Uint8Array>,
    options: { deflate?: boolean; onBytes?: (bytes: number) => void } = {},
  ): Promise<void> {
    const entry: CentralEntry = {
      name: Buffer.from(name),
      method: options.deflate ? DEFLATE : STORE,
      flags: FLAG_UTF8 | FLAG_DESCRIPTOR,
      crc: 0,
      compressedSize: 0,
      size: 0,
      offset: this.offset,
      ...this.stamp,
      zip64: true,
    }
    const extra = Buffer.alloc(20)
    extra.writeUInt16LE(0x0001, 0)
    extra.writeUInt16LE(16, 2)
    const header = Buffer.alloc(30)
    header.writeUInt32LE(LOCAL_HEADER, 0)
    header.writeUInt16LE(45, 4)
    header.writeUInt16LE(entry.flags, 6)
    header.writeUInt16LE(entry.method, 8)
    header.writeUInt16LE(entry.time, 10)
    header.writeUInt16LE(entry.date, 12)
    header.writeUInt32LE(0, 14)
    header.writeUInt32LE(MAX_32, 18)
    header.writeUInt32LE(MAX_32, 22)
    header.writeUInt16LE(entry.name.length, 26)
    header.writeUInt16LE(extra.length, 28)
    await this.write(Buffer.concat([header, entry.name, extra]))

    let crc = 0
    let size = 0
    const counted = async function* () {
      for await (const chunk of source) {
        crc = crc32(chunk, crc)
        size += chunk.length
        options.onBytes?.(chunk.length)
        yield chunk
      }
    }
    const input = counted()
    let data: AsyncIterable<Uint8Array> = input
    if (options.deflate) {
      const deflate = createDeflateRaw()
      void (async () => {
        try {
          for await (const chunk of input) {
            if (!deflate.write(chunk)) await new Promise((resolve) => deflate.once('drain', resolve))
          }
          deflate.end()
        } catch (err) {
          deflate.destroy(err as Error)
        }
      })()
      data = deflate
    }
    const start = this.offset
    for await (const chunk of data)
      await this.write(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.length))
    entry.crc = crc >>> 0
    entry.size = size
    entry.compressedSize = this.offset - start

    const descriptor = Buffer.alloc(24)
    descriptor.writeUInt32LE(DATA_DESCRIPTOR, 0)
    descriptor.writeUInt32LE(entry.crc, 4)
    descriptor.writeBigUInt64LE(BigInt(entry.compressedSize), 8)
    descriptor.writeBigUInt64LE(BigInt(entry.size), 16)
    await this.write(descriptor)
    this.entries.push(entry)
  }

  async finish(): Promise<number> {
    const centralStart = this.offset
    for (const entry of this.entries) {
      const zip64 = entry.zip64 || entry.offset >= MAX_32
      const extra = zip64 ? Buffer.alloc(28) : Buffer.alloc(0)
      if (zip64) {
        extra.writeUInt16LE(0x0001, 0)
        extra.writeUInt16LE(24, 2)
        extra.writeBigUInt64LE(BigInt(entry.size), 4)
        extra.writeBigUInt64LE(BigInt(entry.compressedSize), 12)
        extra.writeBigUInt64LE(BigInt(entry.offset), 20)
      }
      const header = Buffer.alloc(46)
      header.writeUInt32LE(CENTRAL_HEADER, 0)
      header.writeUInt16LE((3 << 8) | 45, 4)
      header.writeUInt16LE(zip64 ? 45 : 20, 6)
      header.writeUInt16LE(entry.flags, 8)
      header.writeUInt16LE(entry.method, 10)
      header.writeUInt16LE(entry.time, 12)
      header.writeUInt16LE(entry.date, 14)
      header.writeUInt32LE(entry.crc, 16)
      header.writeUInt32LE(zip64 ? MAX_32 : entry.compressedSize, 20)
      header.writeUInt32LE(zip64 ? MAX_32 : entry.size, 24)
      header.writeUInt16LE(entry.name.length, 28)
      header.writeUInt16LE(extra.length, 30)
      header.writeUInt16LE(0, 32)
      header.writeUInt16LE(0, 34)
      header.writeUInt16LE(0, 36)
      header.writeUInt32LE((0o100644 << 16) >>> 0, 38)
      header.writeUInt32LE(zip64 ? MAX_32 : entry.offset, 42)
      await this.write(Buffer.concat([header, entry.name, extra]))
    }
    const centralSize = this.offset - centralStart
    const needs64 = centralStart >= MAX_32 || this.entries.length >= MAX_16
    if (needs64) {
      const zip64End = this.offset
      const record = Buffer.alloc(56)
      record.writeUInt32LE(ZIP64_END, 0)
      record.writeBigUInt64LE(44n, 4)
      record.writeUInt16LE((3 << 8) | 45, 12)
      record.writeUInt16LE(45, 14)
      record.writeUInt32LE(0, 16)
      record.writeUInt32LE(0, 20)
      record.writeBigUInt64LE(BigInt(this.entries.length), 24)
      record.writeBigUInt64LE(BigInt(this.entries.length), 32)
      record.writeBigUInt64LE(BigInt(centralSize), 40)
      record.writeBigUInt64LE(BigInt(centralStart), 48)
      const locator = Buffer.alloc(20)
      locator.writeUInt32LE(ZIP64_LOCATOR, 0)
      locator.writeUInt32LE(0, 4)
      locator.writeBigUInt64LE(BigInt(zip64End), 8)
      locator.writeUInt32LE(1, 16)
      await this.write(Buffer.concat([record, locator]))
    }
    const end = Buffer.alloc(22)
    end.writeUInt32LE(END_OF_CENTRAL, 0)
    end.writeUInt16LE(Math.min(this.entries.length, MAX_16), 8)
    end.writeUInt16LE(Math.min(this.entries.length, MAX_16), 10)
    end.writeUInt32LE(Math.min(centralSize, MAX_32), 12)
    end.writeUInt32LE(needs64 ? MAX_32 : centralStart, 16)
    await this.write(end)
    await this.file.close()
    return this.offset
  }

  /** Closes the file without finishing it (the caller deletes it). */
  async abort(): Promise<void> {
    await this.file.close().catch(() => undefined)
  }
}

export interface ZipEntry {
  name: string
  method: number
  size: number
  compressedSize: number
  crc: number
  offset: number
  /** Unix mode bits when the zip was made on a Unix system (0 otherwise). */
  mode: number
}

export class ZipFormatError extends Error {}

/** Reads the central directory (ZIP64 included) of a zip on disk; entries are streamed from the file. */
export class ZipReader {
  private constructor(
    readonly path: string,
    readonly entries: ZipEntry[],
  ) {}

  static async open(path: string): Promise<ZipReader> {
    const file = await open(path, 'r')
    try {
      const { size } = await file.stat()
      const tailSize = Math.min(size, 22 + 0xffff)
      const tail = Buffer.alloc(tailSize)
      await file.read(tail, 0, tailSize, size - tailSize)
      let endAt = -1
      for (let i = tailSize - 22; i >= 0; i--) {
        if (tail.readUInt32LE(i) === END_OF_CENTRAL) {
          endAt = i
          break
        }
      }
      if (endAt < 0) throw new ZipFormatError('not a zip file')
      let count = tail.readUInt16LE(endAt + 10)
      let centralSize = tail.readUInt32LE(endAt + 12)
      let centralStart = tail.readUInt32LE(endAt + 16)
      if (centralStart === MAX_32 || count === MAX_16 || centralSize === MAX_32) {
        const locatorAt = endAt - 20
        if (locatorAt < 0 || tail.readUInt32LE(locatorAt) !== ZIP64_LOCATOR)
          throw new ZipFormatError('missing ZIP64 locator')
        const recordAt = Number(tail.readBigUInt64LE(locatorAt + 8))
        const record = Buffer.alloc(56)
        await file.read(record, 0, 56, recordAt)
        if (record.readUInt32LE(0) !== ZIP64_END) throw new ZipFormatError('bad ZIP64 end record')
        count = Number(record.readBigUInt64LE(32))
        centralSize = Number(record.readBigUInt64LE(40))
        centralStart = Number(record.readBigUInt64LE(48))
      }
      const central = Buffer.alloc(centralSize)
      await file.read(central, 0, centralSize, centralStart)
      const entries: ZipEntry[] = []
      let at = 0
      for (let i = 0; i < count; i++) {
        if (central.readUInt32LE(at) !== CENTRAL_HEADER) throw new ZipFormatError('bad central directory')
        const nameLength = central.readUInt16LE(at + 28)
        const extraLength = central.readUInt16LE(at + 30)
        const commentLength = central.readUInt16LE(at + 32)
        let compressedSize = central.readUInt32LE(at + 20)
        let entrySize = central.readUInt32LE(at + 24)
        let offset = central.readUInt32LE(at + 42)
        const name = central.subarray(at + 46, at + 46 + nameLength).toString('utf8')
        const extra = central.subarray(at + 46 + nameLength, at + 46 + nameLength + extraLength)
        for (let e = 0; e + 4 <= extra.length;) {
          const id = extra.readUInt16LE(e)
          const length = extra.readUInt16LE(e + 2)
          if (id === 0x0001) {
            let field = e + 4
            if (entrySize === MAX_32) {
              entrySize = Number(extra.readBigUInt64LE(field))
              field += 8
            }
            if (compressedSize === MAX_32) {
              compressedSize = Number(extra.readBigUInt64LE(field))
              field += 8
            }
            if (offset === MAX_32) offset = Number(extra.readBigUInt64LE(field))
          }
          e += 4 + length
        }
        entries.push({
          name,
          method: central.readUInt16LE(at + 10),
          crc: central.readUInt32LE(at + 16),
          size: entrySize,
          compressedSize,
          offset,
          mode: central.readUInt8(at + 5) === 3 ? central.readUInt32LE(at + 38) >>> 16 : 0,
        })
        at += 46 + nameLength + extraLength + commentLength
      }
      return new ZipReader(path, entries)
    } finally {
      await file.close()
    }
  }

  entry(name: string): ZipEntry | null {
    return this.entries.find((e) => e.name === name) ?? null
  }

  /** The entry's bytes as stored (compressed when deflated). */
  async rawStream(entry: ZipEntry): Promise<Readable> {
    const file = await open(this.path, 'r')
    const header = Buffer.alloc(30)
    try {
      await file.read(header, 0, 30, entry.offset)
    } finally {
      await file.close()
    }
    if (header.readUInt32LE(0) !== LOCAL_HEADER)
      throw new ZipFormatError(`bad local header for ${entry.name}`)
    const start = entry.offset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28)
    if (entry.compressedSize === 0) return Readable.from([])
    return createReadStream(this.path, { start, end: start + entry.compressedSize - 1 })
  }

  /** The entry's uncompressed content as a stream. */
  async stream(entry: ZipEntry): Promise<Readable> {
    const raw = await this.rawStream(entry)
    if (entry.method === STORE) return raw
    if (entry.method !== DEFLATE) throw new ZipFormatError(`unsupported compression in ${entry.name}`)
    return raw.pipe(createInflateRaw())
  }

  /** Writes an entry to a file, checking its CRC. */
  async extract(name: string, destination: string): Promise<number> {
    const entry = this.entry(name)
    if (!entry) throw new ZipFormatError(`${name} is missing`)
    let crc = 0
    let size = 0
    await pipeline(
      await this.stream(entry),
      new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          crc = crc32(chunk, crc)
          size += chunk.length
          callback(null, chunk)
        },
      }),
      createWriteStream(destination, { mode: 0o600 }),
    )
    if (crc >>> 0 !== entry.crc >>> 0 || size !== entry.size) throw new ZipFormatError(`${name} is corrupted`)
    return size
  }

  /** `maxBytes`: stops inflating past that size (archives from outside), whatever the entry claims. */
  async read(name: string, options: { maxBytes?: number } = {}): Promise<Buffer> {
    const entry = this.entry(name)
    if (!entry) throw new ZipFormatError(`${name} is missing`)
    const max = options.maxBytes ?? Infinity
    if (entry.size > max) throw new ZipFormatError(`${name} is too large`)
    const chunks: Buffer[] = []
    let size = 0
    const stream = await this.stream(entry)
    for await (const chunk of stream) {
      size += (chunk as Buffer).length
      if (size > max) {
        stream.destroy()
        throw new ZipFormatError(`${name} is too large`)
      }
      chunks.push(chunk as Buffer)
    }
    const data = Buffer.concat(chunks)
    if (crc32(data) >>> 0 !== entry.crc >>> 0) throw new ZipFormatError(`${name} is corrupted`)
    return data
  }
}
